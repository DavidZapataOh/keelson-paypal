# @keelson/sdk

Keelson for TypeScript. Your agent asks the user for a mandate, the user signs it with a passkey,
and every purchase is checked by two TEEs before PayPal captures it. Each purchase comes with an
Alibi you can verify offline.

Runs on the PayPal sandbox and Arbitrum Sepolia: no real money moves.

## Install

```sh
npm install @keelson/sdk @keelson/verifier
npx keelson login
```

From this repository, before the packages are on npm:

```sh
pnpm install && pnpm --filter @keelson/sdk... --filter @keelson/verifier... build
node packages/sdk/dist/cli.js login
node packages/sdk/examples/quickstart.mjs
```

`keelson login` opens your browser, signs you in (passkey, or Judge Mode with no sign-up) and saves
the sign-in to `~/.config/keelson/credentials.json`, readable by you only. No form, no key to paste.

## Quickstart

```js
import { Keelson, quote } from "@keelson/sdk";
import { verifyAlibi } from "@keelson/verifier";

const keelson = new Keelson(); // signed in with `npx keelson login`
const req = await keelson.mandates.request({
  name: "Quickstart",
  reason:
    "I buy one pair of Pace Lite running shoes, size 10, at RunFast on the PayPal sandbox, and nothing else.",
  perPurchase: "$100",
  total: "$100",
  until: "1h",
});
console.log(`Approve with your passkey: ${req.approvalUrl}`);
const mandate = await keelson.mandates.waitForApproval(req.id);
const { cart, sources } = await quote([
  { productUrl: "https://store.keelson.finance/products/pace-lite", size: "10", qty: 1 },
]);
const { evidenceRoot } = await keelson.evidence.seal({
  mandateId: mandate.id,
  sources: { ...sources, observation: "Pace Lite, size 10, $99.00." },
});
const { purchaseId } = await keelson.purchases.countersign({ mandate, evidenceRoot, cart });
const purchase = await keelson.purchases.waitFor(purchaseId);
const report = await verifyAlibi(await keelson.alibis.retrieve(purchase.id));
console.log(`Bought ${purchase.id}. Alibi: ${report.verdict}`); // verified-offline
```

The same file is [`examples/quickstart.mjs`](examples/quickstart.mjs).

## Authentication

| Who                      | How                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| You, building an app     | `npx keelson login`; `new Keelson()` reads the saved sign-in and refreshes it                                                                             |
| An operator's own agent  | `KEELSON_CLIENT_ID`, `KEELSON_CLIENT_SECRET` (client credentials) and `KEELSON_AGENT_KEY`, its private P-256 JWK, which closes each mandate it buys under |
| A token you already hold | `KEELSON_TOKEN`, or `new Keelson({ auth: staticToken(token) })`                                                                                           |

Without an operator of your own, Keelson's hosted operator closes the mandate for you and backs at
most $100 per user for an app it does not know.

## Methods

| Method                                                                                         | What it does                                                     |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `mandates.request({ name, reason, perPurchase, total, until, askAbove? })`                     | Asks the user for a mandate; returns `approvalUrl`               |
| `mandates.waitForApproval(requestId)`                                                          | Waits for the passkey and the PayPal hold; returns the `Mandate` |
| `mandates.requestChange(mandateId, { note, ... })`                                             | Asks the user for more room                                      |
| `mandates.list(agentId)` / `mandates.check(mandateId, cart)`                                   | Active mandates; whether a cart would pass, and why not          |
| `requests.retrieve(requestId)`                                                                 | A request's state, without changing it                           |
| `evidence.seal({ mandateId, sources })`                                                        | Seals what the agent saw; returns `evidenceRoot`                 |
| `purchases.countersign({ mandate, evidenceRoot, cart })`                                       | The two TEEs check the cart; on ALLOW, PayPal captures it        |
| `purchases.waitFor(purchaseId)` / `purchases.retrieve(purchaseId)`                             | The purchase once captured, denied or failed                     |
| `alibis.retrieve(id)` / `alibis.receipt(id)` / `alibis.pdf(id)` / `alibis.verifyRemote(bytes)` | The Alibi, its public receipt, its PDF, Keelson's own check      |
| `events.stream(channel)`                                                                       | Live events, resumed with `Last-Event-ID`                        |
| `operators.link(...)` / `operators.grade(agentId)` / `operators.announceRun(...)`              | Operator registration, trust grade, live runs                    |
| `quote(lines)`                                                                                 | Prices a cart from the sandbox store itself                      |

Every request and response type comes from the API's OpenAPI document
(`openapi/keelson.public.json`).

## Errors and retries

Every POST carries an `Idempotency-Key`, the same one on each retry. Connection errors, 408, 429,
5xx and `idempotency-in-progress` are retried twice with backoff, honouring `Retry-After`. Each
attempt times out after 60 s.

| Error                                   | When                                                   | What to do                                              |
| --------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| `AuthenticationError`                   | No sign-in, or it was revoked                          | Run `npx keelson login` again                           |
| `PermissionDeniedError`                 | The token lacks the scope                              | Sign in with the scope the method needs                 |
| `UnprocessableEntityError`              | `invalid-limits`, `hosted-cap`, `evidence-pii`...      | Read `err.type` and `err.detail`, fix the input         |
| `ConflictError`                         | `purchase-exists` is answered for you by `countersign` | Nothing                                                 |
| `RateLimitError`, `InternalServerError` | Retried already                                        | Try later                                               |
| `OutcomeUnknownError`                   | A countersign was sent and its answer was lost         | Never send it again: `purchases.waitFor(err.requestId)` |
| `MandateRequestClosedError`             | The user declined, or the request expired              | Don't ask again unless the user asks you to             |

Every `APIError` has `status`, `type`, `detail`, the full `problem` and the `requestId` to quote to
support.

## Agent frameworks

```js
import { aiSdkTools } from "@keelson/sdk/ai-sdk"; // Vercel AI SDK
import { openAiAgentsTools } from "@keelson/sdk/openai-agents"; // OpenAI Agents SDK
import { langchainTools } from "@keelson/sdk/langchain"; // LangChain, LangGraph
import { keelsonMcpServer } from "@keelson/sdk/claude-agent-sdk"; // Claude Agent SDK
```

Each gives the model Keelson's tools under the names and answers of Keelson's MCP server
(`keelson_request_mandate`, `keelson_submit_evidence`, `keelson_request_countersign`...). A tool
never throws at the model: it answers `{ status, next, message, retryable }`, and `next` says
exactly what to do. None of them adds a byte to the core entry.

## Verifying an Alibi

`@keelson/verifier` checks an Alibi on your machine with the same code as
https://verify.keelson.finance: both TEE signatures, the evidence and the log inclusion proof.
`{ chain: true }` also reads the anchor on Arbitrum Sepolia.

```sh
npx keelson-verify 01M75ZQSJDFE8K76ZKZT08X1B2 --chain
```

## AI coding assistants

The Keelson Context Plugin gives Claude Code, Cursor or any MCP client this SDK's docs, the
operations and their schemas:

```sh
claude mcp add --transport http keelson-docs https://api.keelson.finance/context/mcp
```

## License

Apache-2.0
