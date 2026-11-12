import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { beforeAll, describe, expect, test } from "vitest";
import { createContextServer } from "../src/index.ts";

let client: Client;
beforeAll(async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createContextServer().connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);
});

const call = async (name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })).structuredContent as Record<string, any>;

describe("the Keelson Context Plugin", () => {
  test("offers three read-only tools and one prompt", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_operation", "get_schema", "search_docs"]);
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(["integrate_keelson"]);
  });

  test("get_operation gives the call, the scopes and the TypeScript snippet", async () => {
    const { matches } = await call("get_operation", {
      query: "countersign",
      language: "typescript",
    });
    expect(matches[0]).toMatchObject({
      operationId: "countersign",
      method: "POST",
      path: "/v1/countersign",
    });
    expect(matches[0].scopes).toEqual(["countersign:write", "purchases:write"]);
    expect(matches[0].snippet).toContain("keelson.purchases.countersign(");
  });

  test("and the Python one", async () => {
    const { matches } = await call("get_operation", {
      operationId: "countersign",
      language: "python",
    });
    expect(matches[0].snippet).toContain("client.purchases.countersign(");
  });

  test("get_schema gives the JSON Schema of a Cart", async () => {
    const { schema } = await call("get_schema", { name: "Cart" });
    expect(schema.required).toEqual([
      "merchant",
      "currency",
      "lines",
      "return_days",
      "returns_free",
    ]);
    expect((await call("get_schema", { name: "Nope" })).schema).toBeNull();
  });

  test("search_docs finds how to verify an Alibi offline", async () => {
    const { matches } = await call("search_docs", { query: "verify an Alibi offline" });
    expect(matches.map((m: { text: string }) => m.text).join("\n")).toContain("verifyAlibi");
    expect((await call("search_docs", { query: "zzzz qqqq" })).matches).toEqual([]);
  });

  test("integrate_keelson walks through sign-in and approval", async () => {
    const { messages } = await client.getPrompt({
      name: "integrate_keelson",
      arguments: { language: "typescript", role: "app" },
    });
    const text = (messages[0]?.content as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("npx @keelson-finance/sdk login");
    expect(text).toContain("waitForApproval");
  });
});
