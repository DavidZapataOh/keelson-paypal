import { type DynamicStructuredTool, tool } from "@langchain/core/tools";
import type { Keelson } from "../client.ts";
import { tools } from "../tools.ts";

/** Keelson's tools for LangChain and LangGraph: bind them to a model or an agent. */
export function langchainTools(
  keelson: Keelson,
  o: { agentId?: string } = {},
): DynamicStructuredTool[] {
  return tools(keelson, o).map(
    (t) =>
      tool(async (input: Record<string, unknown>) => JSON.stringify(await t.execute(input)), {
        name: t.name,
        description: t.description,
        schema: t.inputSchema,
      }) as DynamicStructuredTool,
  );
}
