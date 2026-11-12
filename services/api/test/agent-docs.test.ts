import { readFile } from "node:fs/promises";
import { pino } from "pino";
import { expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { testDb, testKv } from "./setup.ts";

const app = createApp({ db: testDb, kv: testKv, log: pino({ level: "silent" }) });
const landing = (name: string) =>
  readFile(new URL(`../../../apps/landing/public/${name}`, import.meta.url), "utf8");

test.each([
  ["/llms.txt", "llms.txt", "text/plain; charset=utf-8"],
  ["/skill.md", "skill.md", "text/markdown; charset=utf-8"],
])("GET %s serves the landing's own file", async (path, file, type) => {
  const res = await app.request(path);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe(type);
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
  expect(await res.text()).toBe(await landing(file));
});

test("llms.txt follows llmstxt.org: an H1, a blockquote, then H2 file lists", async () => {
  const text = await (await app.request("/llms.txt")).text();
  const lines = text.split("\n");
  expect(lines[0]).toBe("# Keelson");
  expect(lines[2]?.startsWith("> ")).toBe(true);
  expect(text.match(/^# /gm)).toHaveLength(1);
  for (const section of text.split(/^## /m).slice(1)) {
    const items = section.split("\n").slice(1).filter(Boolean);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item).toMatch(/^- \[[^\]]+\]\(https:\/\/[^)]+\)(: .+)?$/);
  }
});

test("skill.md opens with front matter naming the skill", async () => {
  const text = await (await app.request("/skill.md")).text();
  const [, front] = text.split(/^---$/m);
  expect(front).toMatch(/^name: keelson$/m);
  expect(front).toMatch(/^description: .{40,1024}$/m);
});

test("the docs name every tool the MCP server registers, and the polling rule", async () => {
  const server = await readFile(new URL("../../mcp/src/server.ts", import.meta.url), "utf8");
  const tools = [...server.matchAll(/"(keelson\.[a-z_]+)",\n\s+\{/g)].map((m) => m[1]);
  expect(tools.length).toBeGreaterThan(10);
  for (const file of ["/llms.txt", "/skill.md"]) {
    const text = await (await app.request(file)).text();
    for (const tool of tools) expect(text, `${file} names ${tool}`).toContain(`\`${tool}\``);
    expect(text).toContain(
      "Never re-call a write tool to finish it; poll `keelson.get_request` / `keelson.get_purchase`.",
    );
    for (const status of [
      "pending_approval",
      "approved",
      "denied",
      "blocked",
      "success",
      "error",
    ]) {
      expect(text).toContain(`\`${status}\``);
    }
  }
});

test("the spec names every discovery document and endpoint the API and landing publish", async () => {
  const spec = await readFile(
    new URL("../../../apps/docs/src/content/docs/reference/spec.mdoc", import.meta.url),
    "utf8",
  );
  for (const name of [
    "/.well-known/authzen-configuration",
    "/access/v1/evaluation",
    "/access/v1/evaluations",
    "/.well-known/jwt-vc-issuer",
    "/problems/{slug}",
    "KEELSON_TEE_SIGNER_V1",
  ]) {
    expect(spec, name).toContain(name);
  }
});
