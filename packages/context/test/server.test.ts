import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { beforeAll, expect, test } from "vitest";
import { createContextServer } from "../src/server.ts";

const client = new Client({ name: "test", version: "1.0.0" });

beforeAll(async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createContextServer().connect(a);
  await client.connect(b);
});

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBeFalsy();
  return result.structuredContent as Record<string, unknown>;
}

type Endpoint = { operationId: string; method: string; path: string; security: string[]; usage: string };

test("lists the prompt and the three tools", async () => {
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(["ask", "endpoint_search", "model_search"]);
  for (const t of tools) expect(t.outputSchema).toBeDefined();
  const { prompts } = await client.listPrompts();
  expect(prompts.map((p) => p.name)).toEqual(["integrate_api"]);
});

test("endpoint_search finds the countersign with its SDK call in each language", async () => {
  const ts = (await call("endpoint_search", { query: "countersign a cart", language: "typescript" }))
    .matches as Endpoint[];
  expect(ts[0]).toMatchObject({ operationId: "countersign", method: "POST", path: "/v1/countersign" });
  expect(ts[0]?.security).toContain("countersign:write");
  expect(ts[0]?.usage).toContain("keelson.countersign(");
  const py = (await call("endpoint_search", { query: "countersign a cart", language: "python" }))
    .matches as Endpoint[];
  expect(py[0]?.usage).toContain("from keelson.generated.api.tee import countersign");
  expect(py[0]?.usage).toContain("countersign.sync_detailed(");
});

test("model_search returns a schema with its required members", async () => {
  const { matches } = await call("model_search", { name: "Cart" });
  const [cart] = matches as { name: string; schema: { required: string[] } }[];
  expect(cart?.name).toBe("Cart");
  expect(cart?.schema.required).toEqual([
    "merchant",
    "currency",
    "lines",
    "return_days",
    "returns_free",
  ]);
});

test("ask answers from the SDK docs and examples", async () => {
  const { matches } = await call("ask", { question: "How do I verify an Alibi offline?" });
  const text = (matches as { text: string }[]).map((m) => m.text).join("\n");
  expect(text).toContain("verifyAlibi");
  const py = await call("ask", { question: "verify an Alibi offline", language: "python" });
  expect((py.matches as { text: string }[])[0]?.text).toContain("verify_alibi");
});

test("an unknown name is an empty answer, not an error", async () => {
  expect((await call("model_search", { name: "NoSuchModel" })).matches).toEqual([]);
  expect((await call("endpoint_search", { query: "zzzz qqqq" })).matches).toEqual([]);
});

test("integrate_api outlines an integration with the SDK", async () => {
  const { messages } = await client.getPrompt({
    name: "integrate_api",
    arguments: { language: "typescript" },
  });
  const text = messages.map((m) => (m.content.type === "text" ? m.content.text : "")).join("\n");
  expect(text).toContain("clientCredentials");
  expect(text).toContain("KeelsonAgent");
  expect(text).toContain("endpoint_search");
});
