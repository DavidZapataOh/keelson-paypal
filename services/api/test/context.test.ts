import { pino } from "pino";
import { expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { testDb, testKv } from "./setup.ts";

const app = createApp({ db: testDb, kv: testKv, log: pino({ level: "silent" }) });

const rpc = (body: unknown) =>
  app.request("/context/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify(body),
  });

test("the Context Plugin answers tools/list without a token", async () => {
  const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  expect(res.status).toBe(200);
  const text = await res.text();
  const json = JSON.parse(text.startsWith("{") ? text : (text.match(/^data: (.*)$/m)?.[1] ?? "{}"));
  expect(json.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
    "get_operation",
    "get_schema",
    "search_docs",
  ]);
});
