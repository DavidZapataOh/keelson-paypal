import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { operations, PUBLIC_OPERATIONS, sample } from "../src/lib/openapi";

const dist = fileURLToPath(new URL("../dist/reference/api", import.meta.url));
const doc = JSON.parse(
  readFileSync(fileURLToPath(new URL("../public/openapi.json", import.meta.url)), "utf8"),
);
const METHODS = ["get", "post", "put", "patch", "delete"];
const count = Object.values(doc.paths as Record<string, object>).reduce(
  (n, item) => n + Object.keys(item).filter((m) => METHODS.includes(m)).length,
  0,
);

describe("the API reference", () => {
  test("has one page per operation", () => {
    const ops = operations();
    expect(ops).toHaveLength(count);
    expect(new Set(ops.map((o) => o.slug)).size).toBe(count);
    const pages = readdirSync(dist, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect(pages.sort()).toEqual(ops.map((o) => o.slug).sort());
  });

  test("documents the verify operation's headers and body from the schema", () => {
    const op = operations().find((o) => o.method === "post" && o.path === "/v1/alibis/verify");
    expect(op?.slug).toBe("verifyAlibi");
    expect(op?.body?.mediaType).toBe("application/vnd.keelson.alibi.v1+json");
    const header = op?.params.find((p) => p.in === "header" && p.name === "Idempotency-Key");
    expect(header?.required).toBe(true);
    expect(op?.responses.map((r) => r.status)).toEqual(["200", "400", "413", "415"]);
    expect(op?.responses[0]?.schema?.properties).toHaveProperty("verdict");
  });

  test("offers try-it only on public operations", () => {
    const tryable = operations()
      .filter((o) => o.tryIt)
      .map((o) => `${o.method.toUpperCase()} ${o.path}`);
    expect(tryable.sort()).toEqual([...PUBLIC_OPERATIONS].sort());
  });

  test("builds a cURL sample with the method, URL, headers and an idempotency key", () => {
    const op = operations().find((o) => o.slug === "verifyAlibi");
    if (!op) throw new Error("the verify operation is missing");
    const curl = sample(op, "curl");
    expect(curl).toContain("curl -X POST https://api.keelson.finance/v1/alibis/verify");
    expect(curl).toContain("-H 'content-type: application/vnd.keelson.alibi.v1+json'");
    expect(curl).toContain('-H "idempotency-key: $(uuidgen)"');
    expect(sample(op, "ts")).toContain(
      'await fetch("https://api.keelson.finance/v1/alibis/verify", {',
    );
  });
});
