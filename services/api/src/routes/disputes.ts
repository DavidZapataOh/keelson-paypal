import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { asc, disputeResponses, disputes, eq, paypalEvents, sql, verdicts } from "@keelson/db";
import { CHAINS, isChainId } from "@keelson/relayer";
import type { Context } from "hono";
import type { Deps } from "../app.ts";
import { ProblemSchema, problem } from "../problem.ts";

const PARTIES = ["operator", "keelson", "merchant", "user"] as const;

const Party = z.enum(PARTIES);

const DisputeStatus = z
  .object({
    dispute_id: z.string(),
    purchase_id: z.string(),
    state: z.enum(["OPEN", "ATTRIBUTED", "RESOLVED"]),
    reason: z.string().openapi({ description: "PayPal's `dispute_reason`." }),
    received_at: z.iso.datetime().nullable().openapi({
      description: "When Keelson received the dispute's first webhook or poll.",
    }),
    attributed_at: z.iso.datetime().nullable(),
    elapsed_ms: z.number().int().nullable().openapi({
      description: "From `received_at` to `attributed_at`; null while the dispute is open.",
    }),
    liable: Party.nullable(),
    parties: z.array(z.object({ party: Party.exclude(["user"]), liable: z.boolean() })).openapi({
      description:
        "The parties a verdict can make pay: the operator's bond, Keelson's reserve, or the merchant through PayPal.",
    }),
    verdict: z
      .object({
        rule: z.string().openapi({ example: "R61" }),
        digest: z.string(),
        chain_id: z.number().int(),
        message: z.record(z.string(), z.string()),
        signatures: z.array(
          z.object({ tee: z.number().int(), signer: z.string(), signature: z.string() }),
        ),
        facts: z.record(z.string(), z.union([z.string(), z.boolean()])),
      })
      .nullable(),
    settlement: z
      .object({
        rail: z.enum(["pyusd", "paypal"]).openapi({
          description:
            "`pyusd`: the payee the verdict names is the merchant. `paypal`: it is Keelson's treasury, which pays the merchant a PayPal Payout.",
        }),
        outcome: z.enum(["paid", "queued", "claimable", "failed"]).nullable().openapi({
          description:
            "`queued`: the slash waits out the veto window until `ready_at`. `claimable`: the PYUSD transfer failed and waits as a claim. Null until the chain answered; always null when neither the operator nor Keelson is liable.",
        }),
        failure: z.string().nullable().openapi({
          description:
            "The contract error that refused the settlement on chain: of a `failed` one, or of one Keelson's treasury paid instead.",
        }),
        paid_by: z.enum(["chain", "treasury"]).nullable().openapi({
          description:
            "`chain`: the operator's bond or Keelson's reserve paid. `treasury`: the chain refused a verdict that still holds (its window or deadline had passed), so Keelson's treasury pays the payee itself, PYUSD on chain or a PayPal Payout; the settlement is paid once `outcome` is `paid`.",
        }),
        refund_id: z.string().nullable().openapi({
          description:
            "The buyer's PayPal refund; its `custom_id` is the verdict's `ksv1.` reference.",
        }),
        tx_hash: z.string().nullable(),
        explorer_url: z.string().nullable(),
        ready_at: z.iso.datetime().nullable(),
        payout_batch_id: z.string().nullable(),
        payout_status: z.string().nullable(),
        settled_at: z.iso.datetime().nullable(),
      })
      .nullable(),
    responses: z
      .array(
        z.object({
          action: z.enum(["provide_evidence", "send_message", "accept_claim"]),
          stage: z.string().openapi({ description: "PayPal's lifecycle stage when it was sent." }),
          evidence_types: z.array(z.string()),
          drafted_by: z.enum(["model", "template"]).nullable().openapi({
            description:
              "`model` when the statement was drafted with citations; `template` when the rule's fixed statement was sent. Null for an accepted claim.",
          }),
          citations: z.number().int().openapi({
            description:
              "How many passages of the Alibi and the verdict the statement cites. The statement itself is not public: it quotes the purchase's Alibi.",
          }),
          sent_at: z.iso.datetime(),
        }),
      )
      .openapi({
        description:
          "What Keelson sent PayPal for the party at fault. The action and the evidence types follow from the rule; a model only drafts the text.",
      }),
  })
  .openapi("DisputeStatus");

interface StoredDraft {
  source: "model" | "template";
  citations: unknown[];
}

const route = createRoute({
  method: "get",
  path: "/v1/disputes/{id}",
  tags: ["Disputes"],
  summary: "A dispute's attribution",
  description:
    "Where a PayPal dispute over a Keelson purchase stands: the party at fault, the `Verdict` both TEE legs signed and the time from the dispute's arrival to its verdict. No authentication; it holds no personal data.",
  request: { params: z.object({ id: z.string().regex(/^PP-[A-Z]-[0-9A-Za-z-]{1,40}$/) }) },
  responses: {
    200: { description: "The dispute", content: { "application/json": { schema: DisputeStatus } } },
    404: {
      description: "No dispute with this id over a Keelson purchase",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

export function registerDisputes(app: OpenAPIHono, deps: Pick<Deps, "db">): void {
  app.openapi(route, (async (c: Context) => {
    const { id } = c.req.param() as { id: string };
    const [row] = await deps.db
      .select({
        id: disputes.id,
        purchaseId: disputes.purchaseId,
        state: disputes.state,
        reason: disputes.reason,
        receivedAt: sql<Date | null>`(select min(${paypalEvents.receivedAt}) from ${paypalEvents} where ${paypalEvents.disputeId} = ${disputes.id})`,
        verdict: verdicts,
      })
      .from(disputes)
      .leftJoin(verdicts, eq(verdicts.disputeId, disputes.id))
      .where(eq(disputes.id, id));
    if (!row) return problem(c, 404, "not-found", "Not found", "No such dispute.");
    const responses = await deps.db
      .select()
      .from(disputeResponses)
      .where(eq(disputeResponses.disputeId, id))
      .orderBy(asc(disputeResponses.createdAt));
    const v = row.verdict;
    const txHash = v?.txHash ? `0x${Buffer.from(v.txHash).toString("hex")}` : null;
    const received = row.receivedAt ? new Date(row.receivedAt) : null;
    const liable = v ? (PARTIES[v.liable - 1] ?? null) : null;
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        dispute_id: row.id,
        purchase_id: row.purchaseId,
        state: row.state,
        reason: row.reason,
        received_at: received?.toISOString() ?? null,
        attributed_at: v?.createdAt.toISOString() ?? null,
        elapsed_ms: v && received ? v.createdAt.getTime() - received.getTime() : null,
        liable,
        parties: (["operator", "keelson", "merchant"] as const).map((party) => ({
          party,
          liable: liable === party,
        })),
        verdict: v
          ? {
              rule: `R${String(v.ruleId).padStart(2, "0")}`,
              digest: `0x${Buffer.from(v.digest).toString("hex")}`,
              chain_id: v.chainId,
              message: v.message,
              signatures: v.signatures,
              facts: v.facts as Record<string, string | boolean>,
            }
          : null,
        settlement: v
          ? {
              rail: v.rail as "pyusd" | "paypal",
              outcome: v.outcome as "paid" | "queued" | "claimable" | "failed" | null,
              failure: v.failure,
              paid_by: v.paidBy as "chain" | "treasury" | null,
              refund_id: v.refundId,
              tx_hash: txHash,
              explorer_url:
                txHash && isChainId(v.chainId)
                  ? `${CHAINS[v.chainId].explorer}/tx/${txHash}`
                  : null,
              ready_at: v.readyAt?.toISOString() ?? null,
              payout_batch_id: v.payoutBatchId,
              payout_status: v.payoutStatus,
              settled_at: v.settledAt?.toISOString() ?? null,
            }
          : null,
        responses: responses.map((r) => {
          const draft = r.draft as StoredDraft | null;
          const input = r.input as { evidences?: { evidence_type: string }[] };
          return {
            action: r.action,
            stage: r.stage,
            evidence_types: input.evidences?.map((e) => e.evidence_type) ?? [],
            drafted_by: draft?.source ?? null,
            citations: draft?.citations.length ?? 0,
            sent_at: r.createdAt.toISOString(),
          };
        }),
      },
      200,
    );
  }) as never);
}
