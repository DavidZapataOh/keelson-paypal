import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { mandates, passkey, session, sql } from "@keelson/db";
import type { Deps } from "../app.ts";
import { PASSKEY_FRESH_MS } from "../auth.ts";
import { requireSession } from "../middleware/auth.ts";
import { userPasskeys } from "../passkeys.ts";
import type { Principal } from "../principal.ts";
import { ProblemSchema, problem } from "../problem.ts";
import { c3SaltKey } from "../zk/c3.ts";

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
    "The passkey can no longer sign in or sign mandates, and the user's other sessions end. It takes a sign-in within the last 10 minutes. A user keeps at least one passkey, so the last one is not removed, and a passkey stays while a mandate it signed is still being proved.",
  middleware: [requireSession()],
  request: { params: z.object({ id: z.string().min(1).max(256) }) },
  responses: {
    204: { description: "Removed" },
    403: {
      description: "The session is older than 10 minutes",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    404: {
      description: "No such passkey of this user",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    409: {
      description: "The user's last passkey, or one whose mandate is still being proved",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    ...problems,
  },
});

export function registerPasskeys(app: OpenAPIHono, deps: Pick<Deps, "db" | "kv">): void {
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
    const principal = c.get("principal") as Principal;
    const userId = principal.subject;
    const { id } = c.req.valid("param");
    const signedIn = principal.session?.createdAt.getTime() ?? 0;
    if (Date.now() - signedIn >= PASSKEY_FRESH_MS) {
      return problem(
        c,
        403,
        "session-not-fresh",
        "Session not fresh",
        "Sign in again to remove a passkey.",
      );
    }
    // Locking the user's passkeys serializes removals, so two at once cannot remove the last.
    const outcome = await deps.db.transaction(async (tx) => {
      const owned = await tx
        .select({ id: passkey.id, credentialId: passkey.credentialID })
        .from(passkey)
        .where(sql`${passkey.userId} = ${userId}`)
        .for("update");
      const target = owned.find((p) => p.id === id);
      if (!target) return "missing";
      if (owned.length === 1) return "last";
      // A C3 proof is made over the registered passkeys, its mandate's among them.
      const unproved = await tx
        .select({ id: mandates.id })
        .from(mandates)
        .where(
          sql`${mandates.userId} = ${userId} and ${mandates.credentialId} = ${target.credentialId} and ${mandates.c3Proof} is null`,
        );
      for (const m of unproved) {
        if (await deps.kv.exists(c3SaltKey(m.id))) return "proving";
      }
      await tx.delete(passkey).where(sql`${passkey.id} = ${id}`);
      // Whoever signed in with the removed passkey is signed out.
      await tx
        .delete(session)
        .where(
          sql`${session.userId} = ${userId} and ${session.id} <> ${principal.session?.id ?? ""}`,
        );
      return "removed";
    });
    if (outcome === "missing") {
      return problem(c, 404, "not-found", "Not found", "You have no passkey with this id.");
    }
    if (outcome === "proving") {
      return problem(
        c,
        409,
        "passkey-in-use",
        "Passkey in use",
        "A mandate signed with this passkey is still being proved. Try again in a minute.",
      );
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
