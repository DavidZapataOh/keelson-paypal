import { type FunctionTool, tool } from "@openai/agents";
import type { Keelson } from "../client.ts";
import { tools } from "../tools.ts";

/** Keelson's tools for the OpenAI Agents SDK: pass them as `tools` to `new Agent()`. */
export function openAiAgentsTools(keelson: Keelson, o: { agentId?: string } = {}): FunctionTool[] {
  return tools(keelson, o).map(
    (t) =>
      tool({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as never,
        strict: false,
        execute: async (input) => JSON.stringify(await t.execute(input as Record<string, unknown>)),
      }) as FunctionTool,
  );
}
