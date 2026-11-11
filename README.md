# Keelson

The liability layer for AI-agent purchases on PayPal. Keelson checks every purchase against what the user signed before it is paid, seals it with an Alibi anyone can verify, and makes the party at fault pay.

## Repository layout

```
.
├── apps/
│   ├── landing/         Astro marketing site
│   └── store/           RunFast, the demo merchant store (PayPal sandbox)
├── packages/
│   ├── core/            Canonical JSON, hashing, EIP-712, money and ULID primitives
│   ├── db/              Drizzle schema, migrations and state machines for PostgreSQL 18
│   └── paypal/          PayPal REST and Server SDK clients
├── services/
│   ├── api/             Hono API: auth, idempotency, rate limits, server-sent events
│   └── mcp/             MCP server: tools, the Alibi MCP App, STDIO entry
├── engine/core/         Rust port of the core primitives, checked against the same vectors
├── circuits/vectors/    Noir circuit that pins the Poseidon2 vectors
├── openapi/             Generated OpenAPI 3.1 document
├── .github/workflows/   CI
├── compose.yaml         Local PostgreSQL and Valkey
├── render.yaml          Render blueprint
├── .env.example         Environment variables
├── pnpm-workspace.yaml  Workspace packages and dependency catalog
├── tsconfig.base.json   Shared compiler options
├── biome.json           Lint and format rules
├── knip.json            Entry points for unused-code checks
├── turbo.json           Task pipeline
└── vitest.config.ts     Shared test configuration
```

## Development

Requires Node.js 26.13.0 (see `.node-version`), pnpm 12.16.1, which Corepack installs from the `packageManager` field, Docker, and the Rust toolchain pinned in `rust-toolchain.toml`.

```sh
corepack enable
pnpm install
cp .env.example .env
docker compose up -d
pnpm build
pnpm migrate
pnpm test
cargo test
```

`pnpm lint` runs Biome, and `pnpm typecheck` runs the TypeScript compiler across the workspace. `pnpm --filter @keelson/paypal test:sandbox` runs the PayPal suite against the PayPal sandbox and needs sandbox credentials in `.env`.

The demo store at https://store.keelson.finance sells as RunFast, a PayPal sandbox business account: checkout runs the PayPal JavaScript SDK v6 against the sandbox, so no real money moves. `KEELSON_LIVE=1 pnpm --filter @keelson/store exec vitest run test/checkout.live.test.ts` buys one pair as the sandbox buyer (`PAYPAL_SANDBOX_BUYER_EMAIL` and `PAYPAL_SANDBOX_BUYER_PASSWORD`); set `STORE_URL` to run it against a deployed store.

## Judge Mode

https://app.keelson.finance/judge opens a temporary tenant with one click (no keys, no sign-up) and walks through the live product in nine steps: a real mandate, the agent run that bought under it and the injected run Keelson blocked, its Alibi in the verifier, a PayPal sandbox dispute with its signed verdict and settlement, the demo merchant's console (read only), the operator's grade, the red-team scoreboard and live status. A judge reads the demo merchant's console and asks its assistant on a budget of its own; it changes nothing, and the nightly reset closes it after 12 hours. https://app.keelson.finance/status shows the health of each dependency.

| Dependency                                                                  | Runs on                       |
| --------------------------------------------------------------------------- | ----------------------------- |
| PayPal                                                                      | Sandbox: no real money moves  |
| Arbitrum Sepolia (bond vault, reserve, verdict verifier, checkpoint anchor) | Testnet, test PYUSD           |
| TEE leg A, Intel TDX on Phala Cloud                                         | Production hardware           |
| TEE leg B, AWS Nitro Enclaves                                               | Production hardware           |
| Alibi log and witnesses                                                     | Production                    |
| Claude (Anthropic API)                                                      | Production                    |
| Agent browser (Kernel)                                                      | Production                    |
| Demo store (RunFast)                                                        | Ours, PayPal sandbox checkout |
| Card issuer (Lithic), for card mandates                                     | Sandbox: no real money moves  |

`JUDGE_LIVE_ORIGIN=https://app.keelson.finance pnpm --filter @keelson/web exec vitest run test/e2e/judge.live.test.ts` runs the judge's journey on production from a clean browser; `.github/workflows/judge-journey.yml` runs it every hour and opens an issue when it fails.

## Card purchases

A mandate signed for "Any store (PayPal card)" pays merchants that take cards rather than PayPal, with the same guarantees: it is paid with PayPal through a Keelson single-use card. Its budget is held on PayPal like any mandate, and every charge is collected from that hold. After both legs allow a cart, Keelson issues a single-use Lithic card capped at the countersigned amount, limited to the merchant category codes and country the mandate allows, and opens it once the purchase is logged and covered. The card number goes from Lithic's hosted page to the agent's browser only (`GET /v1/purchases/{id}/card`). Each authorization the card network sends reaches `POST /webhooks/lithic/asa` (Lithic Auth Stream Access), and both legs check it against their own ALLOW (`POST /v1/card/authorize` on each leg); anything but two verified approvals is declined. The settled charge is collected from the PayPal hold, and the Alibi carries the card, every authorization with both legs' signed answers, and the settlement. A chargeback goes through Lithic's Disputes API with the Alibi as evidence. Lithic's sandbox plays the card network: `LITHIC_API_KEY=… pnpm --filter @keelson/api exec node scripts/card-demo.ts` buys a coffee at a test merchant end to end against the deployed app and API.

## MCP server

Keelson's MCP server is served by the API at `https://api.keelson.finance/mcp` (Streamable HTTP, stateless). It is an OAuth 2.1 protected resource: clients find the authorization server at `/.well-known/oauth-protected-resource`. An agent's own client gets a token with the client credentials grant for the resource `https://api.keelson.finance`; a host acting for a user (claude.ai, ChatGPT, Cursor) registers itself and gets one with the authorization code grant, and buys under the mandates the user approves for it (see [the API's README](services/api/README.md#apps-acting-for-a-user)). Each tool asks for the scope its API calls need. `keelson.get_alibi` renders the Alibi as an MCP App.

Closing a mandate for a countersign takes the agent's own key, which Keelson never holds, so `keelson.request_countersign` is offered by the STDIO server, run as the agent's process. For Claude Desktop, after `pnpm install && pnpm build`, add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "keelson": {
      "command": "node",
      "args": ["/path/to/keelson/services/mcp/dist/stdio.js"],
      "env": {
        "KEELSON_CLIENT_ID": "…",
        "KEELSON_CLIENT_SECRET": "…",
        "KEELSON_AGENT_KEY": "{\"kty\":\"EC\",…}",
        "AGENT_ID": "351"
      }
    }
  }
}
```

The OAuth client needs `countersign:write`, `evidence:write` and `alibis:read`, and must be the one that linked the operator (`POST /v1/operators`). `KEELSON_AGENT_KEY` is the private P-256 JWK of the `cnf` key mandates name. The MCP Inspector runs the same server with `npx @modelcontextprotocol/inspector node services/mcp/dist/stdio.js`.

## License

Apache License 2.0. See [LICENSE](LICENSE).
