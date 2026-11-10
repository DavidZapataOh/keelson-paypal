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

## MCP server

Keelson's MCP server is served by the API at `https://api.keelson.finance/mcp` (Streamable HTTP, stateless). It is an OAuth 2.1 protected resource: clients find the authorization server at `/.well-known/oauth-protected-resource` and get a token with the client credentials grant for the resource `https://api.keelson.finance`; each tool asks for the scope its API calls need. `keelson.get_alibi` renders the Alibi as an MCP App.

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
