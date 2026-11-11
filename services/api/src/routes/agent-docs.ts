import { readFileSync } from "node:fs";
import type { OpenAPIHono } from "@hono/zod-openapi";

/** The landing's copies are the one source; the API serves the same bytes. */
const DOCS = {
  "/llms.txt": { file: "llms.txt", type: "text/plain; charset=utf-8" },
  "/skill.md": { file: "skill.md", type: "text/markdown; charset=utf-8" },
} as const;

/** `/llms.txt` (llmstxt.org) and `/skill.md`, the guide agents read before using the MCP server. */
export function registerAgentDocs(app: OpenAPIHono): void {
  for (const [path, { file, type }] of Object.entries(DOCS)) {
    const body = readFileSync(
      new URL(`../../../../apps/landing/public/${file}`, import.meta.url),
      "utf8",
    );
    app.get(path, (c) =>
      c.body(body, 200, {
        "content-type": type,
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=300",
      }),
    );
  }
}
