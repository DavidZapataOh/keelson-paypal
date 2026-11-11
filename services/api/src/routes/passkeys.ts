import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { passkey, sql } from "@keelson/db";
import type { Deps } from "../app.ts";
import { requireSession } from "../middleware/auth.ts";
import { userPasskeys } from "../passkeys.ts";
import type { Principal } from "../principal.ts";
import { ProblemSchema, problem } from "../problem.ts";

const Passkeys = z
  .object({
    passkeys: z.array(
      z.object({
        id: z.string(),
        credentialId: z.string(),
        name: z.string().nullable(),
        createdAt: z.iso.datetime().nullable(),
        payment: z.boolean().openapi({
          description: "Registered with the SPC `payment` extension, so SPC can use it.",
        }),
      }),
    ),
  })
  .openapi("Passkeys");

const problems = {
  401: {
    description: "Not signed in",
    content: { "application/problem+json": { schema: ProblemSchema } },
  },
} as const;

const list = createRoute({
  method: "get",
  path: "/v1/passkeys",
  tags: ["passkeys"],
  summary: "List the signed-in user's passkeys",
  description: "The credentials a mandate can be signed with, oldest first.",
  middleware: [requireSession()],
  responses: {
    200: { description: "The passkeys", content: { "application/json": { schema: Passkeys } } },
    ...problems,
  },
});

const remove = createRoute({
  method: "delete",
  path: "/v1/passkeys/{id}",
  tags: ["passkeys"],
  summary: "Remove one of the signed-in user's passkeys",
  description:
    "The passkey can no longer sign in or sign mandates. A user keeps at least one passkey, so the last one is not removed.",
  middleware: [requireSession()],
  request: { params: z.object({ id: z.string().min(1).max(256) }) },
  responses: {
    204: { description: "Removed" },
    404: {
      description: "No such passkey of this user",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    409: {
      description: "The user's last passkey",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    ...problems,
  },
});

export function registerPasskeys(app: OpenAPIHono, deps: Pick<Deps, "db">): void {
  app.openapi(list, async (c) => {
    const userId = (c.get("principal") as Principal).subject;
    const rows = await userPasskeys(deps.db, userId);
    return c.json(
      {
        passkeys: rows.map((p) => ({
          id: p.id,
          credentialId: p.credentialID,
          name: p.name,
          createdAt: p.createdAt?.toISOString() ?? null,
          payment: p.payment,
        })),
      },
      200,
    );
  });

  app.openapi(remove, async (c) => {
    const userId = (c.get("principal") as Principal).subject;
    const { id } = c.req.valid("param");
    // Locking the user's passkeys serializes removals, so two at once cannot remove the last.
    const outcome = await deps.db.transaction(async (tx) => {
      const owned = await tx
        .select({ id: passkey.id })
        .from(passkey)
        .where(sql`${passkey.userId} = ${userId}`)
        .for("update");
      if (!owned.some((p) => p.id === id)) return "missing";
      if (owned.length === 1) return "last";
      await tx.delete(passkey).where(sql`${passkey.id} = ${id}`);
      return "removed";
    });
    if (outcome === "missing") {
      return problem(c, 404, "not-found", "Not found", "You have no passkey with this id.");
    }
    if (outcome === "last") {
      return problem(
        c,
        409,
        "last-passkey",
        "Last passkey",
        "Add another passkey before removing this one; you need one to sign.",
      );
    }
    return c.body(null, 204);
  });
}
