import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { Keelson, tools } from "../src/index.ts";

describe("agent tools", () => {
  test("have the hosted MCP server's names, with _ for .", () => {
    const server = readFileSync(
      new URL("../../../services/mcp/src/server.ts", import.meta.url),
      "utf8",
    );
    const mcp = [...server.matchAll(/registerTool\(\s*"(keelson\.[a-z_]+)"/g)]
      .map((m) => (m[1] as string).replace(".", "_"))
      // Compiling a mandate from a sentence hands off to the app; it is not an SDK call.
      .filter((n) => n !== "keelson_compile_mandate")
      .sort();
    const mine = tools(new Keelson({ auth: null }))
      .map((t) => t.name)
      .sort();
    expect(mine).toEqual(mcp);
  });

  test("every input schema is a closed JSON Schema object with its required fields defined", () => {
    for (const t of tools(new Keelson({ auth: null }))) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.additionalProperties).toBe(false);
      for (const r of t.inputSchema.required ?? [])
        expect(t.inputSchema.properties).toHaveProperty(r);
      expect(t.description.length).toBeGreaterThan(40);
    }
  });

  test("a failure is an envelope the model reads, never a throw", async () => {
    const getRequest = tools(new Keelson({ auth: null })).find(
      (t) => t.name === "keelson_get_request",
    );
    const answer = await getRequest?.execute({ requestId: "01JX0000000000000000000000" });
    expect(answer).toMatchObject({
      status: "error",
      retryable: false,
      next: { action: "tell_user" },
    });
  });
});
