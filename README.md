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
│   └── api/             Hono API: auth, idempotency, rate limits, server-sent events
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

## License

Apache License 2.0. See [LICENSE](LICENSE).
