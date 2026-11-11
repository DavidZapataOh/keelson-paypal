import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { toHex } from "@keelson/core";
import { alibis, desc, eq, inArray, mandates, purchases } from "@keelson/db";
import { renderCard } from "@keelson/mandate";
import type { MiddlewareHandler } from "hono";
import type { Deps } from "../app.ts";
import { admitJudge, isInvite, isJudge, tourSeed } from "../judge.ts";
import { MERCHANTS } from "../merchants.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { purchaseView } from "../pipeline/drive.ts";
import { ProblemSchema, problem } from "../problem.ts";
import { Card } from "./mandates.ts";

const problemContent = { "application/problem+json": { schema: ProblemSchema } };

const Started = z
  .object({
    user_id: z.string(),
  })
  .openapi("JudgeSession");

const start = createRoute({
  method: "post",
  path: "/v1/judge/sessions",
  tags: ["judge"],
  summary: "Open a Judge Mode session",
  description:
    "Creates a judge: a tenant with no email, no account and no key, signed in with a session cookie until the nightly reset after 12 hours. A judge reads the demo merchant's console (no changes), walks the tour, and can sign its own mandates with a passkey like any user. Five per hour per address, and a cap a day over every address that a judge with the invite is counted apart from.",
  request: {
    body: {
      required: false,
      content: {
        "application/json": {
          schema: z.object({
            invite: z.string().max(256).optional().openapi({
              description: "The invite from the hackathon's testing instructions.",
            }),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "The judge, signed in (the session cookie is set)",
      content: { "application/json": { schema: Started } },
    },
    403: { description: "Not called from the app's origin", content: problemContent },
    409: { description: "Already signed in as someone else", content: problemContent },
    429: { description: "Too many judges", content: problemContent },
    503: { description: "Sign-in is not configured", content: problemContent },
  },
});

const Check = z.object({ field: z.string(), color: z.string(), pass: z.boolean() });

const TourPurchase = z
  .object({
    id: z.string().openapi({ description: "The purchase's ULID, which is also its Alibi id." }),
    state: z.string(),
    mode: z.string().nullable(),
    amount: z.object({ currency: z.string(), minor: z.string() }),
    merchant_id: z.string(),
    created_at: z.iso.datetime(),
    log_index: z.string().nullable(),
    capture_id: z.string().nullable(),
    coverage_tx: z.string().nullable(),
    failure: z.string().nullable(),
    checks: z.array(Check).openapi({ description: "Each mandate field the engine checked." }),
    alibi_fragment: z.string().nullable().openapi({
      description:
        "`<leaf hash>.<anchored size>.<chain id>`: the fragment of the Alibi's verifier link, `https://verify.keelson.finance/a/<id>#<fragment>`.",
    }),
  })
  .openapi("JudgeTourPurchase");

const Tour = z
  .object({
    merchant_id: z.string(),
    agent_id: z.string().nullable(),
    mandate: z
      .object({
        id: z.string(),
        state: z.string(),
        mandate_hash: z.string().nullable(),
        budget: z.object({ currency: z.string(), max_minor: z.string() }),
        created_at: z.iso.datetime(),
        card: Card.nullable(),
        purchases: z.array(TourPurchase),
      })
      .nullable(),
    anonymous_purchase: z
      .object({ id: z.string(), alibi_fragment: z.string().nullable() })
      .nullable()
      .openapi({
        description:
          "The newest test purchase whose C1 and C3 proofs are composed into one anonymous proof, served at `GET /v1/anonymous-purchases/{id}`.",
      }),
    dispute_id: z.string().nullable(),
    campaign_id: z.string().nullable(),
  })
  .openapi("JudgeTour");

const tour = createRoute({
  method: "get",
  path: "/v1/judge/tour",
  tags: ["judge"],
  summary: "What the Judge Mode tour shows",
  description:
    "The newest real records on this deployment: the demo operator's latest mandate with a captured purchase (its card and every purchase under it, blocked ones included), the latest sandbox dispute with a verdict, and the latest finished red-team campaign. Judges only.",
  responses: {
    200: { description: "The tour", content: { "application/json": { schema: Tour } } },
    401: { description: "No session", content: problemContent },
    403: { description: "Not a judge", content: problemContent },
  },
});

const NO_EVIDENCE = { merchantSignedCheckout: false, zkTlsFields: new Set<never>() };

function checksOf(trace: unknown): z.infer<typeof Check>[] {
  const fields = (trace as { fields?: { id?: unknown; color?: unknown; pass?: unknown }[] } | null)
    ?.fields;
  if (!Array.isArray(fields)) return [];
  return fields.flatMap((f) =>
    typeof f.id === "string" && typeof f.pass === "boolean"
      ? [{ field: f.id, color: typeof f.color === "string" ? f.color : "gray", pass: f.pass }]
      : [],
  );
}

/** Admits only a judge's session. */
function requireJudge(deps: Pick<Deps, "db">): MiddlewareHandler {
  return async (c, next) => {
    const principal = c.var.principal;
    if (!principal) {
      return problem(c, 401, "unauthorized", "Unauthorized", "Start Judge Mode first.");
    }
    if (principal.kind !== "user" || !(await isJudge(deps.db, principal.subject))) {
      return problem(c, 403, "not-judge", "Not a judge", "This session is not a Judge Mode one.");
    }
    await next();
  };
}

export function registerJudge(
  app: OpenAPIHono,
  deps: Pick<
    Deps,
    "db" | "kv" | "log" | "auth" | "rateLimit" | "demoAgentId" | "appOrigin" | "judgeInvite"
  >,
): void {
  const { db, auth } = deps;
  app.on(
    "POST",
    "/v1/judge/sessions",
    rateLimit(deps.kv, {
      name: "judge",
      limit: 5,
      anonymousLimit: 5,
      windowSec: 3600,
      failClosed: true,
      trustProxy: deps.rateLimit?.trustProxy ?? false,
    }),
  );
  app.use("/v1/judge/tour", requireJudge(deps));

  app.openapi(start, async (c) => {
    if (!auth) return problem(c, 503, "dependency-unavailable", "Sign-in unavailable");
    // A form on another site cannot sign its visitors in as judges.
    if (deps.appOrigin && c.req.header("origin") !== deps.appOrigin) {
      return problem(c, 403, "cross-origin", "Forbidden", "Start Judge Mode from the app.");
    }
    if (c.var.principal) {
      return problem(
        c,
        409,
        "signed-in",
        "Already signed in",
        "Sign out before starting Judge Mode.",
      );
    }
    const invited = isInvite(deps.judgeInvite, c.req.valid("json")?.invite);
    if (!(await admitJudge(deps.kv, deps.log, invited))) {
      return problem(c, 429, "judges-full", "Too many judges", "Today's judges are all taken.");
    }
    const { headers, response } = await auth.api.signInAnonymous({
      headers: c.req.raw.headers,
      returnHeaders: true,
    });
    if (!response) throw new Error("anonymous sign-in returned no user");
    for (const cookie of headers.getSetCookie()) c.header("Set-Cookie", cookie, { append: true });
    c.header("Cache-Control", "no-store");
    return c.json({ user_id: response.user.id }, 201);
  });

  app.openapi(tour, async (c) => {
    const seed = await tourSeed(db, deps.demoAgentId);
    let mandate: z.infer<typeof Tour>["mandate"] = null;
    if (seed.mandateId) {
      const [row] = await db.select().from(mandates).where(eq(mandates.id, seed.mandateId));
      const bought = await db
        .select()
        .from(purchases)
        .where(eq(purchases.mandateId, seed.mandateId))
        .orderBy(desc(purchases.createdAt))
        .limit(10);
      const leaves = await db
        .select({ purchaseId: alibis.purchaseId, leafHash: alibis.leafHash })
        .from(alibis)
        .where(
          inArray(
            alibis.purchaseId,
            bought.map((p) => p.id),
          ),
        );
      const fragment = (p: (typeof bought)[number]) => {
        const leaf = leaves.find((l) => l.purchaseId === p.id)?.leafHash;
        return leaf && p.anchoredSize !== null && p.chainId !== null
          ? `${Buffer.from(leaf).toString("base64url")}.${p.anchoredSize}.${p.chainId}`
          : null;
      };
      if (row) {
        mandate = {
          id: row.id,
          state: row.state,
          mandate_hash: row.mandateHash ? toHex(row.mandateHash) : null,
          budget: { currency: row.currency, max_minor: row.maxMinor.toString() },
          created_at: row.createdAt.toISOString(),
          card:
            row.payloadSd && row.disclosures
              ? renderCard(row.payloadSd as object, row.disclosures, NO_EVIDENCE, row.decoySalts)
              : null,
          purchases: bought.map((p) => {
            const v = purchaseView(p);
            return {
              id: p.id,
              state: p.state,
              mode: v.mode,
              amount: v.amount,
              merchant_id: p.merchantId,
              created_at: p.createdAt.toISOString(),
              log_index: v.logIndex ?? null,
              capture_id: v.capture?.id ?? null,
              coverage_tx: v.coverage?.txHash ?? null,
              failure: v.failure ? `${v.failure.step}: ${v.failure.reason}` : null,
              checks: checksOf(p.evalTrace),
              alibi_fragment: fragment(p),
            };
          }),
        };
      }
    }
    let anonymous: z.infer<typeof Tour>["anonymous_purchase"] = null;
    if (seed.anonymousPurchaseId) {
      const [p] = await db
        .select({
          id: purchases.id,
          anchoredSize: purchases.anchoredSize,
          chainId: purchases.chainId,
          leafHash: alibis.leafHash,
        })
        .from(purchases)
        .innerJoin(alibis, eq(alibis.purchaseId, purchases.id))
        .where(eq(purchases.id, seed.anonymousPurchaseId));
      if (p) {
        anonymous = {
          id: p.id,
          alibi_fragment:
            p.anchoredSize !== null && p.chainId !== null
              ? `${Buffer.from(p.leafHash).toString("base64url")}.${p.anchoredSize}.${p.chainId}`
              : null,
        };
      }
    }
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        merchant_id: (MERCHANTS[0] as (typeof MERCHANTS)[number]).id,
        agent_id: deps.demoAgentId?.toString() ?? null,
        mandate,
        anonymous_purchase: anonymous,
        dispute_id: seed.disputeId,
        campaign_id: seed.campaignId,
      },
      200,
    );
  });
}
