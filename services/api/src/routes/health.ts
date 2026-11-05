import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";

const route = createRoute({
  method: "get",
  path: "/health",
  tags: ["system"],
  summary: "Liveness probe",
  responses: {
    200: {
      description: "The service is up",
      content: { "application/json": { schema: z.object({ status: z.literal("ok") }) } },
    },
  },
});

export function registerHealth(app: OpenAPIHono): void {
  app.openapi(route, (c) => c.json({ status: "ok" as const }, 200));
}
