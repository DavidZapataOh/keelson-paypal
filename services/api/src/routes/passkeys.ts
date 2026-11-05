import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Deps } from "../app.ts";
import { requireSession } from "../middleware/auth.ts";
import { userPasskeys } from "../passkeys.ts";
import type { Principal } from "../principal.ts";
import { ProblemSchema } from "../problem.ts";

const Passkeys = z
  .object({
    passkeys: z.array(
      z.object({
        credentialId: z.string(),
        payment: z.boolean().openapi({
          description: "Registered with the SPC `payment` extension, so SPC can use it.",
        }),
      }),
    ),
  })
  .openapi("Passkeys");

const route = createRoute({
  method: "get",
  path: "/v1/passkeys",
  tags: ["passkeys"],
  summary: "List the signed-in user's passkeys",
  description: "The credentials a mandate can be signed with, oldest first.",
  middleware: [requireSession()],
  responses: {
    200: { description: "The passkeys", content: { "application/json": { schema: Passkeys } } },
    401: {
      description: "Not signed in",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

export function registerPasskeys(app: OpenAPIHono, deps: Pick<Deps, "db">): void {
  app.openapi(route, async (c) => {
    const userId = (c.get("principal") as Principal).subject;
    const rows = await userPasskeys(deps.db, userId);
    return c.json(
      { passkeys: rows.map((p) => ({ credentialId: p.credentialID, payment: p.payment })) },
      200,
    );
  });
}
