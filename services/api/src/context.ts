import type { OpenAPIHono } from "@hono/zod-openapi";
import { createContextServer } from "@keelson/context";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { bodyLimit } from "hono/body-limit";

/**
 * The Keelson Context Plugin on Streamable HTTP at `/context/mcp`, stateless and public: Keelson's
 * SDK docs, operations and schemas for AI coding assistants. It reads nothing but its own corpus.
 */
export function registerContext(app: OpenAPIHono, limit: Parameters<OpenAPIHono["use"]>[1]): void {
  const handler = createMcpHandler(() => createContextServer());
  app.use(
    "/context/mcp",
    bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "payload too large" }, 413) }),
    limit,
  );
  app.all("/context/mcp", (c) => handler.fetch(c.req.raw));
}
