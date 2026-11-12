import { jsonSchema, type Tool, tool } from "ai";
import type { Keelson } from "../client.ts";
import { tools } from "../tools.ts";

/** Keelson's tools for the Vercel AI SDK: pass them as `tools` to `generateText` or `streamText`. */
export function aiSdkTools(keelson: Keelson, o: { agentId?: string } = {}): Record<string, Tool> {
  return Object.fromEntries(
    tools(keelson, o).map((t) => [
      t.name,
      tool({
        description: t.description,
        inputSchema: jsonSchema<Record<string, unknown>>(t.inputSchema),
        execute: (input) => t.execute(input),
      }),
    ]),
  );
}
