import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  and,
  cardChargebacks,
  disputes,
  eq,
  mandates,
  purchaseCards,
  purchases,
  sql,
} from "@keelson/db";
import { loadAlibi } from "../alibi/issue.ts";
import { alibiPdf } from "../alibi/pdf.ts";
import type { Deps } from "../app.ts";
import {
  CHARGEBACK_REASONS,
  chargebackOpen,
  chargebackRecovered,
  chargebackView,
  refundToUser,
} from "../cards/chargeback.ts";
import { requireSession } from "../middleware/auth.ts";
import { publishPurchase } from "../pipeline/events.ts";
import { ProblemSchema, problem } from "../problem.ts";

const problemContent = { "application/problem+json": { schema: ProblemSchema } };
const Id = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
/** Purchase states in which the card network has settled and nothing is disputed yet. */
const SETTLED = new Set(["CAPTURED", "DELIVERED", "SETTLED"]);

const Chargeback = z
  .object({
    id: z.string(),
    purchaseId: z.string(),
    reason: z.enum(["not_received", "not_as_described", "unauthorized"]),
    networkCodes: z.object({ visa: z.string(), mastercard: z.string() }),
    amountMinor: z.string(),
    status: z.string(),
    resolution: z.string().nullable(),
    recoveredMinor: z.string().nullable(),
    evidenceUploaded: z.boolean(),
  })
  .openapi("CardChargeback");

const route = createRoute({
  method: "post",
  path: "/v1/purchases/{id}/chargeback",
  operationId: "chargeBackPurchase",
  tags: ["purchases"],
  summary: "Charge back a card purchase",
  description:
    "Files a chargeback through the card issuer over a card purchase's settled transaction, with the purchase's Alibi as the cardholder's evidence: Visa 13.1 or Mastercard 4853 for an item not received, Visa 13.3 or 4853 for one not as described, Visa 10.4 or Mastercard 4837 for a charge the user did not authorize. What the chargeback returns is subtracted from any bond claim over the purchase, and no bond claim is paid while it is open. Only the mandate's owner files it, one at a time.",
  middleware: [requireSession()],
  request: {
    params: z.object({ id: Id }),
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.strictObject({
            reason: z.enum(["not_received", "not_as_described", "unauthorized"]),
            note: z.string().max(1000).default(""),
            amountMinor: z
              .string()
              .regex(/^[1-9][0-9]{0,15}$/)
              .optional()
              .openapi({ description: "Defaults to the settled amount, and cannot exceed it." }),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: "Filed", content: { "application/json": { schema: Chargeback } } },
    404: { description: "No such card purchase of this user", content: problemContent },
    409: {
      description: "The card is not settled yet, or a chargeback is already open",
      content: problemContent,
    },
    422: { description: "The amount is above what was settled", content: problemContent },
    503: {
      description: "The card issuer is not configured or unavailable",
      content: problemContent,
    },
  },
});

export function registerChargebacks(
  app: OpenAPIHono,
  deps: Pick<Deps, "db" | "kv" | "log" | "cards">,
): void {
  const { db } = deps;
  app.openapi(route, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const [row] = await db
      .select({ purchase: purchases, card: purchaseCards, userId: mandates.userId })
      .from(purchases)
      .innerJoin(mandates, eq(mandates.id, purchases.mandateId))
      .innerJoin(purchaseCards, eq(purchaseCards.purchaseId, purchases.id))
      .where(eq(purchases.id, id));
    if (!row || row.userId !== c.var.principal?.subject) {
      return problem(c, 404, "not-found", "Not found");
    }
    const issuer = deps.cards?.issuer;
    if (!issuer) return problem(c, 503, "cards-unconfigured", "Cards unconfigured");
    // One filing at a time per purchase: the issuer must not get two chargebacks for one charge.
    const lock = `chargeback:${id}`;
    if ((await deps.kv.set(lock, "1", { NX: true, PX: 30_000 })) !== "OK") {
      return problem(c, 409, "chargeback-open", "Chargeback open", "A chargeback is being filed.");
    }
    try {
      const { card, purchase } = row;
      if (!SETTLED.has(purchase.state) || !card.transactionToken || card.settledMinor === null) {
        return problem(
          c,
          409,
          "not-settled",
          "Not settled",
          "A chargeback is filed over the card network's settled transaction.",
        );
      }
      const amount = body.amountMinor ? BigInt(body.amountMinor) : card.settledMinor;
      if (amount > card.settledMinor) {
        return problem(c, 422, "invalid-amount", "Invalid amount", "Above what was settled.");
      }
      const [open] = await db
        .select({ id: cardChargebacks.id })
        .from(cardChargebacks)
        .where(
          and(
            eq(cardChargebacks.purchaseId, id),
            sql`${cardChargebacks.status} not in ('CASE_WON', 'CASE_CLOSED')`,
          ),
        );
      if (open) {
        return problem(
          c,
          409,
          "chargeback-open",
          "Chargeback open",
          `Chargeback ${open.id} is open.`,
        );
      }
      let filed: { token: string; status: string };
      try {
        filed = await issuer.chargeback({
          transactionToken: card.transactionToken,
          amountMinor: amount,
          reason: body.reason,
          note: body.note,
        });
      } catch (err) {
        deps.log.warn({ err, purchaseId: id }, "chargeback not filed");
        return problem(c, 503, "issuer-unavailable", "The card issuer did not take the chargeback");
      }
      // The chargeback is the purchase's dispute: once the card network decides it, Keelson
      // attributes it and the agent's bond pays what the chargeback did not return.
      const stored = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(cardChargebacks)
          .values({
            id: filed.token,
            purchaseId: id,
            reason: body.reason,
            amountMinor: amount,
            status: filed.status,
          })
          .returning();
        await tx.insert(disputes).values({
          id: filed.token,
          purchaseId: id,
          reason: CHARGEBACK_REASONS[body.reason].issuer,
          raw: { rail: "card", reason: body.reason, amount_minor: amount.toString() },
        });
        return inserted;
      });
      // The Alibi is the cardholder's evidence: the mandate the user signed and both enclaves'
      // approvals of the cart and of the charge.
      let evidenceUploaded = false;
      try {
        const bundle = await loadAlibi(db, id);
        if (bundle) {
          const { pdf } = await alibiPdf(deps.log, bundle);
          await issuer.attachEvidence(filed.token, `alibi-${id}.pdf`, pdf);
          evidenceUploaded = true;
          await db
            .update(cardChargebacks)
            .set({ evidenceUploaded: true })
            .where(eq(cardChargebacks.id, filed.token));
        }
      } catch (err) {
        deps.log.warn({ err, purchaseId: id }, "chargeback evidence not attached");
      }
      await db
        .update(purchases)
        .set({ state: "DISPUTED", updatedAt: sql`now()` })
        .where(and(eq(purchases.id, id), eq(purchases.state, purchase.state)));
      await publishPurchase(deps, id, { type: "purchase.chargeback", chargebackId: filed.token });
      return c.json(
        chargebackView({ ...(stored as typeof cardChargebacks.$inferSelect), evidenceUploaded }),
        201,
      );
    } finally {
      await deps.kv.del(lock);
    }
  });
}

/**
 * Records the issuer's news about a chargeback: its status, its resolution, what it returned. Once
 * the card network decided it, the dispute is attributed.
 */
export async function applyChargeback(
  deps: Pick<Deps, "db" | "log" | "paypal" | "startDisputeWorkflow">,
  d: { token: string; status: string; resolution: string | null },
): Promise<void> {
  const [row] = await deps.db.select().from(cardChargebacks).where(eq(cardChargebacks.id, d.token));
  if (!row) return;
  // A decided chargeback stays decided: an older event arriving late changes nothing.
  if (!chargebackOpen(row.status)) return;
  const recovered = chargebackRecovered(d.status, d.resolution, row.amountMinor);
  await deps.db
    .update(cardChargebacks)
    .set({
      status: d.status,
      resolution: d.resolution,
      recoveredMinor: recovered,
      updatedAt: sql`now()`,
    })
    .where(eq(cardChargebacks.id, d.token));
  // What the chargeback won came back to Keelson, the cardholder: it goes on to the user.
  if (recovered) {
    await refundToUser(
      deps,
      row.purchaseId,
      d.token,
      recovered,
      `Refund of chargeback ${d.token} on your card purchase.`,
    );
  }
  // Once the card network decided it, Keelson attributes the dispute.
  if (!chargebackOpen(d.status)) await deps.startDisputeWorkflow?.(d.token, d.status);
}
