import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  attacks,
  desc,
  disputes,
  eq,
  mandates,
  merchantSettlement,
  paypalEvents,
  purchases,
  redTeamCampaigns,
  sql,
  verdicts,
} from "@keelson/db";
import { CHAINS, isChainId } from "@keelson/relayer";
import type { Context, MiddlewareHandler } from "hono";
import type { Deps } from "../app.ts";
import { isJudge } from "../judge.ts";
import { challenge } from "../middleware/auth.ts";
import { MERCHANTS, merchantOfUser, SETTLEMENT } from "../merchants.ts";
import { purchaseView } from "../pipeline/drive.ts";
import { ProblemSchema, problem } from "../problem.ts";
import { AmberCaseSchema, amberOfPurchases } from "./disputes.ts";

const PARTIES = ["operator", "keelson", "merchant", "user"] as const;

declare module "hono" {
  interface ContextVariableMap {
    merchantId: string | undefined;
    /** Set when a judge reads the demo merchant's console: the judge's user id. */
    judgeId: string | undefined;
  }
}

/** The merchant Judge Mode shows: the demo store's. */
const DEMO_MERCHANT = (MERCHANTS[0] as (typeof MERCHANTS)[number]).id;

/** What a judge may do in the demo merchant's console: read it and ask its assistant. */
const judgeMay = (method: string, path: string) =>
  method === "GET" || (method === "POST" && path.endsWith("/assistant"));

const problems = {
  401: {
    description: "No session",
    content: { "application/problem+json": { schema: ProblemSchema } },
  },
  403: {
    description: "The session is not this merchant's",
    content: { "application/problem+json": { schema: ProblemSchema } },
  },
} as const;

/**
 * Admits only the session of the merchant in the path: a user signed in (EIP-4361) with that
 * merchant's settlement address. A judge reads the demo merchant's console and asks its
 * assistant; it changes nothing. Sets `c.var.merchantId`, and `c.var.judgeId` for a judge.
 */
export function requireMerchant(deps: Pick<Deps, "db" | "merchantSigners">): MiddlewareHandler {
  return async (c, next) => {
    if (c.var.invalidToken) {
      challenge(c, 'error="invalid_token"');
      return problem(c, 401, "invalid-token", "Invalid token", "The access token is invalid.");
    }
    const principal = c.var.principal;
    if (!principal) {
      return problem(c, 401, "unauthorized", "Unauthorized", "A merchant session is required.");
    }
    const merchant =
      principal.kind === "user"
        ? await merchantOfUser(deps.db, principal.subject, deps.merchantSigners ?? SETTLEMENT)
        : undefined;
    const wanted = c.req.param("merchantId");
    if (
      !merchant &&
      principal.kind === "user" &&
      (wanted === undefined || wanted === DEMO_MERCHANT) &&
      (await isJudge(deps.db, principal.subject))
    ) {
      if (!judgeMay(c.req.method, c.req.path)) {
        return problem(c, 403, "read-only", "Read only", "Judge Mode cannot change a merchant.");
      }
      c.set("merchantId", DEMO_MERCHANT);
      c.set("judgeId", principal.subject);
      return next();
    }
    if (!merchant || (wanted !== undefined && merchant.id !== wanted)) {
      return problem(
        c,
        403,
        "not-merchant",
        "Not this merchant",
        "Sign in with this merchant's settlement wallet.",
      );
    }
    c.set("merchantId", merchant.id);
    await next();
  };
}

const MerchantId = z.object({ merchantId: z.string().min(1).max(64) });

const Me = z
  .object({
    merchant_id: z.string(),
    name: z.string(),
    website: z.url(),
    settlement_address: z.string().openapi({
      description: "The wallet the merchant signs in and signs its choices with.",
    }),
    read_only: z.boolean().openapi({
      description: "True for a Judge Mode session: it reads the console and changes nothing.",
    }),
  })
  .openapi("MerchantSelf");

const Settlement = z
  .object({
    rail: z.enum(["pyusd", "paypal"]),
    paypal_receiver: z.string().nullable(),
    nonce: z.string().openapi({ description: "The nonce of the last signed choice; 0 if none." }),
    updated_at: z.iso.datetime().nullable(),
  })
  .openapi("MerchantSettlement");

const DisputeRow = z
  .object({
    dispute_id: z.string(),
    purchase_id: z.string().openapi({ description: "Also the id of the purchase's Alibi." }),
    state: z.enum(["OPEN", "ATTRIBUTED", "RESOLVED"]),
    reason: z.string(),
    amount_minor: z.string(),
    currency: z.string(),
    agent_id: z.string().openapi({ description: "The ERC-8004 agent that made the purchase." }),
    received_at: z.iso.datetime().nullable(),
    attributed_at: z.iso.datetime().nullable(),
    elapsed_ms: z.number().int().nullable(),
    liable: z.enum(PARTIES).nullable(),
    rule: z.string().nullable(),
    rail: z.enum(["pyusd", "paypal"]).nullable(),
    outcome: z.enum(["paid", "queued", "claimable", "failed"]).nullable(),
    paid_by: z.enum(["chain", "treasury", "violation-pool"]).nullable(),
    ready_at: z.iso.datetime().nullable(),
    settled_at: z.iso.datetime().nullable(),
    explorer_url: z.url().nullable(),
    has_alibi: z.boolean(),
    amber: AmberCaseSchema.nullable(),
  })
  .openapi("MerchantDispute");

const OrderRow = z
  .object({
    purchase_id: z.string().openapi({ description: "Also the id of the purchase's Alibi." }),
    created_at: z.iso.datetime(),
    state: z.string().openapi({ description: "`DENIED` when Keelson blocked the cart." }),
    amount_minor: z.string(),
    currency: z.string(),
    agent_id: z.string().openapi({ description: "The ERC-8004 agent that made the purchase." }),
    has_alibi: z.boolean(),
    blocked: z.array(z.object({ field: z.string(), cart: z.string().nullable() })).openapi({
      description:
        "For a blocked cart, each mandate field whose check failed and what the cart had. The mandate's own bound stays with the buyer.",
    }),
    dispute: z
      .object({
        dispute_id: z.string(),
        state: z.enum(["OPEN", "ATTRIBUTED", "RESOLVED"]),
        liable: z.enum(PARTIES).nullable(),
      })
      .nullable(),
  })
  .openapi("MerchantOrder");

/** The latest purchases and attacks read per source: each yields one row per mandate field. */
const EVALUATIONS_LIMIT = 20_000;

const EVALUATION_COLUMNS = [
  "source",
  "evaluation_id",
  "at",
  "agent",
  "operator",
  "field",
  "color",
  "failed",
  "decision",
  "attack_class",
  "dispute_id",
  "liable",
] as const;

const Evaluations = z
  .object({
    columns: z.array(z.enum(EVALUATION_COLUMNS)),
    rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
  })
  .openapi("MerchantEvaluations", {
    description:
      "One row per mandate field per evaluation at this merchant: its countersigned purchases and the red-team campaigns' attacks. `failed` is 1 when the field's check failed.",
  });

const me = createRoute({
  method: "get",
  path: "/v1/merchants/me",
  operationId: "getMerchant",
  tags: ["merchants"],
  summary: "The merchant signed in",
  responses: {
    200: { description: "The merchant", content: { "application/json": { schema: Me } } },
    ...problems,
  },
});

const settlement = createRoute({
  method: "get",
  path: "/v1/merchants/{merchantId}/settlement",
  operationId: "getSettlement",
  tags: ["merchants"],
  summary: "How a merchant is paid when a dispute goes its way",
  request: { params: MerchantId },
  responses: {
    200: {
      description: "The current choice",
      content: { "application/json": { schema: Settlement } },
    },
    ...problems,
  },
});

const disputeList = createRoute({
  method: "get",
  path: "/v1/merchants/{merchantId}/disputes",
  operationId: "listMerchantDisputes",
  tags: ["merchants"],
  summary: "A merchant's disputes and their verdicts",
  description:
    "The latest 500 PayPal disputes over the merchant's Keelson purchases, newest first.",
  request: { params: MerchantId },
  responses: {
    200: {
      description: "The disputes",
      content: { "application/json": { schema: z.object({ disputes: z.array(DisputeRow) }) } },
    },
    ...problems,
  },
});

const orderList = createRoute({
  method: "get",
  path: "/v1/merchants/{merchantId}/orders",
  operationId: "listMerchantOrders",
  tags: ["merchants"],
  summary: "The agent purchases at a merchant",
  description:
    "The latest 100 purchases agents asked Keelson to countersign at the merchant, newest first: the ones it allowed and the ones it blocked, with the dispute over each.",
  request: { params: MerchantId },
  responses: {
    200: {
      description: "The orders",
      content: { "application/json": { schema: z.object({ orders: z.array(OrderRow) }) } },
    },
    ...problems,
  },
});

const evaluations = createRoute({
  method: "get",
  path: "/v1/merchants/{merchantId}/evaluations",
  operationId: "listMerchantEvaluations",
  tags: ["merchants"],
  summary: "Field-level evaluations of the agents that shopped at a merchant",
  request: { params: MerchantId },
  responses: {
    200: {
      description: "The evaluations, as columns and rows",
      content: { "application/json": { schema: Evaluations } },
    },
    ...problems,
  },
});

interface TraceField {
  id?: unknown;
  color?: unknown;
  pass?: unknown;
}

function fieldsOf(trace: unknown): { id: string; color: string; pass: boolean }[] {
  const fields = (trace as { fields?: TraceField[] } | null)?.fields;
  if (!Array.isArray(fields)) return [];
  return fields.flatMap((f) =>
    typeof f.id === "string" && typeof f.pass === "boolean"
      ? [{ id: f.id, color: typeof f.color === "string" ? f.color : "gray", pass: f.pass }]
      : [],
  );
}

const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());

export function registerMerchantConsole(
  app: OpenAPIHono,
  deps: Pick<Deps, "db" | "kv" | "log" | "chains" | "merchantSigners">,
): void {
  const guard = requireMerchant(deps);
  app.use("/v1/merchants/me", guard);
  for (const path of ["settlement", "disputes", "orders", "evaluations"]) {
    app.on("GET", `/v1/merchants/:merchantId/${path}`, guard);
  }
  const signers = deps.merchantSigners ?? SETTLEMENT;

  app.openapi(me, (c) => {
    // The guard resolved the session to one of these merchants.
    const merchant = MERCHANTS.find((m) => m.id === c.var.merchantId) as (typeof MERCHANTS)[number];
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        merchant_id: merchant.id,
        name: merchant.name,
        // A PayPal merchant always names its website.
        website: merchant.website as string,
        settlement_address: signers[merchant.id] as string,
        read_only: c.var.judgeId !== undefined,
      },
      200,
    );
  });

  app.openapi(settlement, async (c) => {
    const { merchantId } = c.req.valid("param");
    const [row] = await deps.db
      .select()
      .from(merchantSettlement)
      .where(eq(merchantSettlement.merchantId, merchantId));
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        rail: (row?.rail ?? "pyusd") as "pyusd" | "paypal",
        paypal_receiver: row?.paypalReceiver ?? null,
        nonce: row?.nonce ?? "0",
        updated_at: row ? iso(row.updatedAt) : null,
      },
      200,
    );
  });

  app.openapi(disputeList, (async (c: Context) => {
    const merchantId = c.var.merchantId as string;
    const rows = await deps.db
      .select({
        id: disputes.id,
        purchaseId: disputes.purchaseId,
        state: disputes.state,
        reason: disputes.reason,
        amountMinor: purchases.amountMinor,
        currency: purchases.currency,
        agentId: mandates.operatorAgentId,
        receivedAt: sql<
          string | null
        >`(select min(${paypalEvents.receivedAt}) from ${paypalEvents} where ${paypalEvents.disputeId} = ${disputes.id})`,
        hasAlibi: sql<boolean>`exists (select 1 from alibis where alibis.purchase_id = ${disputes.purchaseId})`,
        verdict: verdicts,
      })
      .from(disputes)
      .innerJoin(purchases, eq(purchases.id, disputes.purchaseId))
      .innerJoin(mandates, eq(mandates.id, purchases.mandateId))
      .leftJoin(verdicts, eq(verdicts.disputeId, disputes.id))
      .where(eq(purchases.merchantId, merchantId))
      .orderBy(desc(disputes.createdAt))
      .limit(500);
    const ambers = await amberOfPurchases(
      deps,
      rows.map((r) => r.purchaseId),
    );
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        disputes: rows.map((r) => {
          const v = r.verdict;
          const received = r.receivedAt ? new Date(r.receivedAt) : null;
          const txHash = v?.txHash ? `0x${Buffer.from(v.txHash).toString("hex")}` : null;
          return {
            dispute_id: r.id,
            purchase_id: r.purchaseId,
            state: r.state,
            reason: r.reason,
            amount_minor: r.amountMinor.toString(),
            currency: r.currency,
            agent_id: r.agentId.toString(),
            received_at: received?.toISOString() ?? null,
            attributed_at: v ? v.createdAt.toISOString() : null,
            elapsed_ms: v && received ? v.createdAt.getTime() - received.getTime() : null,
            liable: v ? (PARTIES[v.liable - 1] ?? null) : null,
            rule: v ? `R${String(v.ruleId).padStart(2, "0")}` : null,
            rail: v ? v.rail : null,
            outcome: v?.outcome ?? null,
            paid_by: v?.paidBy ?? null,
            ready_at: v?.readyAt?.toISOString() ?? null,
            settled_at: v?.settledAt?.toISOString() ?? null,
            explorer_url:
              txHash && v && isChainId(v.chainId)
                ? `${CHAINS[v.chainId].explorer}/tx/${txHash}`
                : null,
            has_alibi: r.hasAlibi,
            amber: ambers.get(r.purchaseId) ?? null,
          };
        }),
      },
      200,
    );
  }) as never);

  app.openapi(orderList, (async (c: Context) => {
    const merchantId = c.var.merchantId as string;
    const rows = await deps.db
      .select({
        purchase: purchases,
        agentId: mandates.operatorAgentId,
        hasAlibi: sql<boolean>`exists (select 1 from alibis where alibis.purchase_id = ${purchases.id})`,
        disputeId: disputes.id,
        disputeState: disputes.state,
        liable: verdicts.liable,
      })
      .from(purchases)
      .innerJoin(mandates, eq(mandates.id, purchases.mandateId))
      .leftJoin(disputes, eq(disputes.purchaseId, purchases.id))
      .leftJoin(verdicts, eq(verdicts.disputeId, disputes.id))
      .where(eq(purchases.merchantId, merchantId))
      .orderBy(desc(purchases.createdAt))
      .limit(100);
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        orders: rows.map((r) => ({
          purchase_id: r.purchase.id,
          created_at: r.purchase.createdAt.toISOString(),
          state: r.purchase.state,
          amount_minor: r.purchase.amountMinor.toString(),
          currency: r.purchase.currency,
          agent_id: r.agentId.toString(),
          has_alibi: r.hasAlibi,
          blocked: (purchaseView(r.purchase).reasons ?? []).map(({ field, cart }) => ({
            field,
            cart,
          })),
          dispute: r.disputeId
            ? {
                dispute_id: r.disputeId,
                state: r.disputeState as "OPEN" | "ATTRIBUTED" | "RESOLVED",
                liable: r.liable ? (PARTIES[r.liable - 1] ?? null) : null,
              }
            : null,
        })),
      },
      200,
    );
  }) as never);

  app.openapi(evaluations, (async (c: Context) => {
    const merchantId = c.var.merchantId as string;
    const bought = await deps.db
      .select({
        id: purchases.id,
        at: purchases.createdAt,
        trace: purchases.evalTrace,
        agentId: mandates.operatorAgentId,
        disputeId: disputes.id,
        liable: verdicts.liable,
      })
      .from(purchases)
      .innerJoin(mandates, eq(mandates.id, purchases.mandateId))
      .leftJoin(disputes, eq(disputes.purchaseId, purchases.id))
      .leftJoin(verdicts, eq(verdicts.disputeId, disputes.id))
      .where(sql`${purchases.merchantId} = ${merchantId} and ${purchases.evalTrace} is not null`)
      .orderBy(desc(purchases.createdAt))
      .limit(EVALUATIONS_LIMIT);
    // The ledger line is the attack's record, byte for byte; its fields are read in place.
    const line = sql`(${attacks.line})::jsonb`;
    const attacked = await deps.db
      .select({
        id: attacks.id,
        at: attacks.createdAt,
        model: sql<string | null>`${line}->>'model'`,
        backbone: sql<string | null>`${line}->>'backbone'`,
        attackClass: sql<string | null>`${line}->>'class'`,
        trace: sql<unknown>`${line}->'trace'`,
        agentId: sql<string | null>`(${redTeamCampaigns.header})::jsonb#>>'{config,agentId}'`,
      })
      .from(attacks)
      .innerJoin(redTeamCampaigns, eq(redTeamCampaigns.id, attacks.campaign))
      .where(sql`${line}#>>'{quote,cart,merchant}' = ${merchantId}`)
      .orderBy(desc(attacks.createdAt))
      .limit(EVALUATIONS_LIMIT);

    const rows: (string | number | null)[][] = [];
    for (const p of bought) {
      const decision = (p.trace as { decision?: string } | null)?.decision ?? null;
      for (const f of fieldsOf(p.trace)) {
        rows.push([
          "purchase",
          p.id,
          p.at.toISOString(),
          `Agent #${p.agentId}`,
          p.agentId.toString(),
          f.id,
          f.color,
          f.pass ? 0 : 1,
          decision,
          null,
          p.disputeId,
          p.liable ? (PARTIES[p.liable - 1] ?? null) : null,
        ]);
      }
    }
    for (const a of attacked) {
      const decision = (a.trace as { decision?: string } | null)?.decision ?? null;
      const agent = [a.model, a.backbone].filter(Boolean).join(" · ") || "unknown";
      for (const f of fieldsOf(a.trace)) {
        rows.push([
          "red-team",
          a.id,
          a.at.toISOString(),
          agent,
          a.agentId,
          f.id,
          f.color,
          f.pass ? 0 : 1,
          decision,
          a.attackClass,
          null,
          null,
        ]);
      }
    }
    c.header("Cache-Control", "no-store");
    return c.json({ columns: [...EVALUATION_COLUMNS], rows }, 200);
  }) as never);
}
