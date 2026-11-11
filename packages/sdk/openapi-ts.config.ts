import { readFileSync } from "node:fs";
import { defineConfig } from "@hey-api/openapi-ts";
import { parse } from "yaml";

type Operation = { parameters?: { in: string; name: string }[] | undefined };

// Every POST carries an Idempotency-Key, which the SDK's fetch sets; callers never pass it.
const spec = parse(readFileSync(new URL("../../openapi/keelson.yaml", import.meta.url), "utf8"));
for (const path of Object.values(spec.paths as Record<string, Record<string, Operation>>)) {
  for (const op of Object.values(path)) {
    op.parameters = op.parameters?.filter(
      (p) => !(p.in === "header" && p.name.toLowerCase() === "idempotency-key"),
    );
  }
}

export default defineConfig({
  input: spec,
  output: { path: "src/generated", format: "biome", lint: null },
  plugins: [
    "@hey-api/typescript",
    "@hey-api/client-fetch",
    {
      name: "@hey-api/sdk",
      operations: { strategy: "single", containerName: "KeelsonApi" },
    },
  ],
});
