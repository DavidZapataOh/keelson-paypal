// Writes openapi/keelson.public.json: the operations a developer calls, from the full document.
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";

type Json = Record<string, unknown>;

const root = new URL("../../../openapi/", import.meta.url);
const full = parse(readFileSync(new URL("keelson.yaml", root), "utf8")) as Json & {
  paths: Record<string, Record<string, Json>>;
  components: { schemas: Record<string, unknown>; securitySchemes: Json };
};
const keep = new Set<string>(
  JSON.parse(readFileSync(new URL("public-operations.json", root), "utf8")),
);

/** Keeps only OAuth requirements: the session cookie belongs to Keelson's own app. */
function oauthOnly(operation: Json): Json {
  const security = operation.security as Record<string, string[]>[] | undefined;
  if (!security) return operation;
  return { ...operation, security: security.filter((s) => "oauth2" in s) };
}

const paths: Record<string, Record<string, Json>> = {};
for (const [path, operations] of Object.entries(full.paths)) {
  for (const [method, operation] of Object.entries(operations)) {
    if (!keep.has(operation.operationId as string)) continue;
    paths[path] ??= {};
    paths[path][method] = oauthOnly(operation);
  }
}

function collect(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) for (const n of node) collect(n, out);
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string") out.add(v.split("/").at(-1) as string);
      else collect(v, out);
    }
  }
}

const reached = new Set<string>();
collect(paths, reached);
for (let size = -1; size !== reached.size; ) {
  size = reached.size;
  for (const name of [...reached]) collect(full.components.schemas[name], reached);
}

const schemas = Object.fromEntries(
  [...reached].sort().map((name) => [name, full.components.schemas[name]]),
);
const doc = {
  openapi: full.openapi,
  info: {
    ...(full.info as Json),
    description:
      "The operations an app or an operator's agent calls: ask for a mandate, seal evidence, countersign a cart, and read and verify the Alibi. Runs on the PayPal sandbox and Arbitrum Sepolia.",
  },
  servers: [{ url: "https://api.keelson.finance" }],
  components: { schemas, securitySchemes: { oauth2: full.components.securitySchemes.oauth2 } },
  paths,
};
writeFileSync(new URL("keelson.public.json", root), `${JSON.stringify(doc, null, 2)}\n`);
