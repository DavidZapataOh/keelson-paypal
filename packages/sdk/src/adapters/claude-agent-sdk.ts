import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { fromJSONSchema, type ZodObject } from "zod";
import type { Keelson } from "../client.ts";
import { tools } from "../tools.ts";

/**
 * Keelson's tools as an in-process MCP server for the Claude Agent SDK:
 * `query({ prompt, options: { mcpServers: { keelson: keelsonMcpServer(keelson) } } })`.
 */
export function keelsonMcpServer(
  keelson: Keelson,
  o: { agentId?: string } = {},
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "keelson",
    tools: tools(keelson, o).map((t) =>
      tool(
        t.name,
        t.description,
        (fromJSONSchema(t.inputSchema as never) as ZodObject).shape,
        async (input) => {
          const envelope = await t.execute(input as Record<string, unknown>);
          return {
            content: [{ type: "text", text: `${envelope.message}\nNext: ${envelope.next.say}` }],
            structuredContent: envelope,
            ...(envelope.status === "error" ? { isError: true } : {}),
          };
        },
        { annotations: { readOnlyHint: t.readOnly } },
      ),
    ),
  });
}
