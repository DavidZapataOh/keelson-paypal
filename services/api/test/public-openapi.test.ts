import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../openapi/${name}`, import.meta.url), "utf8"));

const publicOperations: string[] = read("public-operations.json");

interface Doc {
  paths: Record<string, Record<string, { operationId: string }>>;
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
  servers: { url: string }[];
}

const doc = (): Doc => read("keelson.public.json");

function refs(node: unknown, out: Set<string>): Set<string> {
  if (Array.isArray(node)) for (const n of node) refs(n, out);
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string") out.add(v.split("/").at(-1) as string);
      else refs(v, out);
    }
  }
  return out;
}

test("keeps exactly the developer operations", () => {
  const d = doc();
  const ids = Object.values(d.paths).flatMap((p) => Object.values(p).map((o) => o.operationId));
  expect(ids.sort()).toEqual([...publicOperations].sort());
  expect(publicOperations).toHaveLength(22);
  expect(Object.keys(d.paths).join(" ")).not.toMatch(/judge|redteam|merchant|embed|push|admin/);
  expect(d.servers).toEqual([{ url: "https://api.keelson.finance" }]);
  expect(Object.keys(d.components.securitySchemes)).toEqual(["oauth2"]);
});

test("keeps every schema an operation reaches and no other", () => {
  const d = doc();
  const reached = refs(d.paths, new Set());
  let size = -1;
  while (reached.size !== size) {
    size = reached.size;
    for (const name of [...reached]) refs(d.components.schemas[name], reached);
  }
  expect(Object.keys(d.components.schemas).sort()).toEqual([...reached].sort());
});

test("documents the operator a request names", () => {
  const state = doc().components.schemas.ConnectionRequestState as { required: string[] };
  expect(state.required).toContain("operatorAgentId");
});
