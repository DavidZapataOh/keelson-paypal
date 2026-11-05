# Keelson

The liability layer for AI-agent purchases on PayPal. Keelson checks every purchase against what the user signed before it is paid, seals it with an Alibi anyone can verify, and makes the party at fault pay.

## Repository layout

```
.
├── apps/
│   └── landing/     Astro marketing site
├── biome.json       Lint and format rules
├── turbo.json       Task pipeline
└── vitest.config.ts Shared test configuration
```

## Development

Requires Node.js 26.13.0 (see `.node-version`) and pnpm 12.16.1, which Corepack installs from the `packageManager` field.

```sh
corepack enable
pnpm install
pnpm build
pnpm test
```

`pnpm lint` runs Biome, and `pnpm typecheck` runs the TypeScript compiler across the workspace.

## License

Apache License 2.0. See [LICENSE](LICENSE).
