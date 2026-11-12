import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Deps } from "../app.ts";
import { bothLegs } from "../tee/coordinator.ts";

const route = createRoute({
  method: "get",
  path: "/v1/engine/capabilities",
  operationId: "getEngineCapabilities",
  tags: ["system"],
  summary: "What both TEEs do",
  description:
    "The features both TEE legs run, which a client may use: `decoys`, a mandate padded with decoy digests (RFC 9901 section 4.2.5).",
  responses: {
    200: {
      description: "The features both legs report",
      content: {
        "application/json": { schema: z.object({ decoys: z.boolean() }).openapi("Capabilities") },
      },
    },
  },
});

export function registerEngineCapabilities(app: OpenAPIHono, deps: Pick<Deps, "tee">): void {
  app.openapi(route, async (c) => {
    const both = deps.tee ? await bothLegs({ tee: deps.tee }) : { decoys: false };
    c.header("Cache-Control", "public, max-age=60");
    return c.json({ decoys: both.decoys }, 200);
  });
}
