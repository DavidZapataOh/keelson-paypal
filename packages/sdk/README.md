# @keelson/sdk

TypeScript SDK for Keelson's API: ask a user for a spending mandate, get each cart countersigned before PayPal captures it, and verify the purchase's Alibi on your own machine.

The client is generated from Keelson's OpenAPI document ([`openapi/keelson.yaml`](../../openapi/keelson.yaml)), one method per operation. On top of it the SDK adds OAuth, retries with idempotency keys, the agent flow with the same answers as Keelson's MCP tools, and the reference Alibi verifier.

Keelson's API at `https://api.keelson.finance` runs on the **PayPal sandbox** and anchors on **Arbitrum Sepolia**: no real money moves.

```sh
npm install @keelson/sdk
```

Node.js 22 or later, or any runtime with `fetch` and Web Crypto.

## The client

```ts
import { clientCredentials, Keelson, unwrap } from "@keelson/sdk";

const keelson = new Keelson({
  auth: clientCredentials({
    clientId: process.env.KEELSON_CLIENT_ID!,
    clientSecret: process.env.KEELSON_CLIENT_SECRET!,
    scopes: ["countersign:write", "evidence:write"],
  }),
});

// Each operation of the OpenAPI document, by its operationId. Typed request and answer.
const { data, error, response } = await keelson.getPurchase({ path: { id: purchaseId } });

// Or the data, with any RFC 9457 problem thrown as a KeelsonError (status, type, problem).
const purchase = await unwrap(keelson.getPurchase({ path: { id: purchaseId } }));
```

Every call:

- sends the bearer token, and gets one fresh token if the API answers `401 invalid_token`;
- gives each POST an `Idempotency-Key`, the same across its retries, so Keelson runs it at most once (set your own in `headers` to make a retry across processes safe);
- retries network failures, `408`, `425`, `429`, `5xx` and a `409 idempotency-in-progress`, up to three times with exponential backoff and full jitter, honoring `Retry-After` (`retry: { maxRetries, baseDelayMs, maxDelayMs }`).

Public operations (`getHealth`, `listLivePurchases`, `getAlibiReceipt`, `verifyAlibi`, `getTrustGrade`, …) need no `auth`.

## Authentication

| Who                         | Grant                                        | Helper                                                                          |
| --------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------- |
| An operator's own agent     | Client credentials (RFC 6749 §4.4)            | `clientCredentials({ clientId, clientSecret, scopes })`                         |
| An app acting for a user    | Authorization code with PKCE S256 (RFC 7636)  | `registerPublicClient`, `createAuthorizationRequest`, `exchangeCode`, `userTokens` |
| A token you already have    |                                              | `staticToken(token)`                                                            |

Every token is requested for the resource `https://api.keelson.finance` (RFC 8707).

An app acting for a user registers itself once, sends the user to sign in and consent, and keeps the tokens:

```ts
import {
  createAuthorizationRequest,
  exchangeCode,
  Keelson,
  registerPublicClient,
  userTokens,
} from "@keelson/sdk";

const redirectUri = "http://127.0.0.1:8976/callback";
const clientId = await registerPublicClient({ clientName: "My shopping app", redirectUris: [redirectUri] });
const { url, codeVerifier, state } = await createAuthorizationRequest({ clientId, redirectUri });
// Open `url` for the user. Keelson redirects to `redirectUri?code=…&state=…`; check `state`.
const tokens = await exchangeCode({ clientId, code, codeVerifier, redirectUri });
const keelson = new Keelson({ auth: userTokens({ clientId, tokens, onTokens: save }) });
```

Such a token holds `mandates:request`, `evidence:write`, `purchases:write`, `alibis:read` and `offline_access`, for that user only. When the user stops every agent, the refresh token is revoked and `token()` rejects with `OAuthError` `invalid_grant`: ask the user to sign in again.

## The agent flow

`KeelsonAgent` runs the same steps as Keelson's MCP tools and answers with the same envelope:

```ts
{ status, next: { action, tool?, arguments?, afterSeconds?, say }, message, ...fields }
```

| `status`           | Meaning                                              | What the agent does                                     |
| ------------------ | ---------------------------------------------------- | ------------------------------------------------------- |
| `pending_approval` | The user has to answer first.                        | Show `approvalUrl` and `matchNumber` together, then poll. |
| `approved`         | The user or Keelson said yes; the work goes on.      | Follow `next`.                                          |
| `denied`           | The user said no.                                    | Stop. Do not ask again unless the user says so.         |
| `blocked`          | Keelson refused it under the mandate. An answer.     | Change the cart or ask for more room.                   |
| `success`          | Done, for good.                                      | Report it. Only now is a purchase bought.               |
| `error`            | It failed; `retryable` says whether to call again.   | Call again only if `retryable`.                         |

`next.tool` names the MCP tool; its method here is the camelCase name without `keelson.` (`keelson.get_request` → `getRequest`). A write is never called again to finish what it started: `getRequest` and `getPurchase` are the polls, and `settle(envelope)` follows them for you. A purchase with `outcome: "unknown"` may have moved money: poll it, never start it again.

### Request a mandate

[`examples/request-mandate.ts`](examples/request-mandate.ts)

```ts
const agent = new KeelsonAgent(keelson);
const asked = await agent.requestMandate({
  name: "Running shoes agent",
  reason: "I will buy one pair of running shoes in your size from RunFast, comparing the models in stock and staying under the price you set.",
  perPurchaseMinor: 15_000,
  totalMinor: 15_000,
  until: new Date(Date.now() + 24 * 3_600_000).toISOString(),
});
console.log(asked.next.say); // the link and the two-digit number to show the user
const answer = await agent.settle(asked);
```

The request is an RFC 8628 device authorization: the user opens the link, picks the number your agent shows out of three, and signs with a passkey. Then `confirmMandate()` finds the mandate once the user approved its PayPal hold.

### Countersign

[`examples/countersign.ts`](examples/countersign.ts) buys from Keelson's demo store under a held mandate:

```ts
const agent = new KeelsonAgent(keelson, {
  agentId: process.env.KEELSON_AGENT_ID,
  agentKey: await importAgentKey(process.env.KEELSON_AGENT_KEY!), // the P-256 key the mandate names
});
const sealed = await agent.submitEvidence({ mandateId, product, cart, observation });
const check = await agent.checkCart({ mandateId, cart }); // a dry run, nothing signed
const sent = await agent.requestCountersign({ mandateId, evidenceRoot: sealed.evidenceRoot, cart });
const done = await agent.settle(sent); // success once PayPal captured it
```

`submitEvidence` seals the store's product and cart answers and what the agent read, each with its own salt, and stores the manifest; `requestCountersign` closes the open mandate with the agent's key over this request and this cart (a key binding JWT, `kb+jwt`) and sends it once. An app acting for a user leaves `agentKey` out: Keelson closes the mandate with its hosted operator's key.

## Verify an Alibi offline

[`examples/verify-alibi.ts`](examples/verify-alibi.ts)

```ts
import { fetchAlibi, Keelson, verifyAlibi } from "@keelson/sdk";

const report = await verifyAlibi(await fetchAlibi(new Keelson(), purchaseId));
report.verdict; // "verified-offline"
const anchored = await verifyAlibi(alibi, { chain: true }); // also reads the anchor: "verified"
```

The checks are the browser verifier's at verify.keelson.finance, run on your machine: the user's passkey over the mandate, both TEE attestations (Intel TDX and AWS Nitro) and countersignatures, the Cedar policy replay, log inclusion and witness cosignatures, the RFC 3161 timestamps, zero-knowledge proofs and, with `chain`, the anchor on Arbitrum. Keelson's servers are asked nothing. Each check reports `pass`, `fail`, `undisclosed`, `pending`, `absent` or `unreachable`; the verdict is `verified` (`verified-offline` without the chain) only if none failed. A public receipt (`getAlibiReceipt`) verifies too, with the sections it does not carry `undisclosed`.

The same verifier is a command:

```sh
npx keelson-verify alibi.json            # exit 0 verified, 1 failed, 2 incomplete
npx keelson-verify --chain --rpc <url> -  # from stdin, reading the anchor
```

## With the PayPal Agent Toolkit

`@keelson/sdk/ai-sdk` gives Keelson's tools to the AI SDK in the Agent Toolkit's shape. Put them next to PayPal's so the agent gets a mandate and a countersign before PayPal captures anything:

```ts
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";
import { KeelsonAgentToolkit } from "@keelson/sdk/ai-sdk";

const tools = {
  ...new PayPalAgentToolkit({ clientId, clientSecret, configuration: { actions: { orders: { get: true } } } }).getTools(),
  ...new KeelsonAgentToolkit({ agent }).getTools(),
};
```

The tools are `keelson_request_mandate`, `keelson_get_request`, `keelson_confirm_mandate`, `keelson_submit_evidence`, `keelson_check_cart`, `keelson_request_countersign`, `keelson_get_purchase` and `keelson_verify_alibi`. `ai` 6 or later is an optional peer dependency.

## Development

```sh
pnpm --filter @keelson/sdk generate   # regenerate src/generated from openapi/keelson.yaml
pnpm --filter @keelson/sdk build
pnpm --filter @keelson/sdk test       # transport tests
KEELSON_LIVE=1 pnpm --filter @keelson/sdk test   # plus the public API on the sandbox
```

`test/operator.live.test.ts` runs as an operator when `KEELSON_CLIENT_ID`, `KEELSON_CLIENT_SECRET`, `KEELSON_AGENT_ID` and `KEELSON_AGENT_KEY` are set; its purchase needs a mandate the user signed for that operator, held on PayPal, with $129 left.
