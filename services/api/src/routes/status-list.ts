import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { STATUS_LIST_TYP } from "@keelson/mandate";
import type { Deps } from "../app.ts";
import { ProblemSchema, problem } from "../problem.ts";
import { publishedStatusToken } from "../status-list.ts";

const MEDIA_TYPE = `application/${STATUS_LIST_TYP}`;

const route = createRoute({
  method: "get",
  path: "/status/v1/mandates/2026-1",
  tags: ["mandates"],
  summary: "The mandate status list",
  description:
    "The Token Status List (draft-ietf-oauth-status-list-21) of every mandate that carries a `status` claim: one bit per mandate, set once it is revoked or its user stopped their agents. Signed by the TEE that issues mandates, with the issuer key the open mandates name; it never clears a bit. Both TEEs check it on every countersign.",
  responses: {
    200: {
      description: "The current status list token",
      content: { [MEDIA_TYPE]: { schema: z.string() } },
    },
    404: {
      description: "No list is published yet",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

export function registerStatusList(app: OpenAPIHono, deps: Pick<Deps, "db">): void {
  app.openapi(route, (async (c: Parameters<Parameters<typeof app.openapi>[1]>[0]) => {
    const token = await publishedStatusToken(deps.db);
    if (!token) return problem(c, 404, "not-found", "Not found", "No status list yet.");
    c.header("Cache-Control", "public, max-age=60");
    return c.body(token, 200, { "Content-Type": MEDIA_TYPE });
  }) as never);
}
