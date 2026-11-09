import { randomBytes } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { leafHashOf } from "@keelson/alibi";
import {
  alibis,
  disputeResponses,
  disputes,
  eq,
  mandates,
  operators,
  purchases,
  timestamps,
  user,
  verdicts,
} from "@keelson/db";
import { adjudicate, getDispute, requireEvidence } from "@keelson/paypal";
import { pino } from "pino";
import { ulid } from "ulid";
import { beforeAll, describe, expect, test } from "vitest";
import { fixtures } from "../../../packages/alibi/test/fixtures.ts";
import { createApp } from "../src/app.ts";
import { respondToDispute } from "../src/disputes/respond.ts";
import { createPayPalDeps } from "../src/paypal.ts";
import { testDb, testKv } from "./setup.ts";

/** A buyer-opened sandbox dispute waiting for the seller's evidence. */
const disputeId = process.env.PAYPAL_RESPOND_DISPUTE_ID;
const f = fixtures[0];
const log = pino({ level: process.env.LOG_LEVEL ?? "info" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Stores the purchase's Alibi and a user-at-fault verdict (R70: the cart met the mandate) for
 * the dispute, as `evaluateDispute` leaves them, so the response step runs on its own.
 */
async function seed(id: string): Promise<void> {
  const b = f?.bundle as NonNullable<typeof f>["bundle"];
  const c = b.tee.countersign;
  const owner = `user-${randomBytes(6).toString("hex")}`;
  await testDb.insert(user).values({ id: owner, name: "Tester", email: `${owner}@example.test` });
  await testDb
    .insert(operators)
    .values({
      agentId: BigInt(c.agentId),
      chainId: 421614,
      agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
      name: "op",
      cnfJwk: {},
    })
    .onConflictDoNothing();
  const mandateId = ulid();
  await testDb.insert(mandates).values({
    id: mandateId,
    userId: owner,
    operatorAgentId: BigInt(c.agentId),
    state: "ACTIVE",
    currency: "USD",
    maxMinor: 10_000n,
    remainingMinor: 10_000n,
    merchantIds: [String(b.eval.context.merchant)],
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  await testDb
    .insert(purchases)
    .values({
      id: b.alibi_id,
      mandateId,
      state: "ATTRIBUTED",
      merchantId: String(b.eval.context.merchant),
      currency: "USD",
      amountMinor: BigInt(c.amount),
      cartHash: Buffer.from(c.cartHash.slice(2), "hex"),
      invoiceId: b.paypal.invoice_id ?? null,
      paypalCaptureId: b.paypal.capture_id ?? null,
      paypalOrderId: b.paypal.order_id ?? null,
    })
    .onConflictDoNothing();
  const hash = Buffer.from(leafHashOf(b));
  for (const t of b.timestamps) {
    await testDb
      .insert(timestamps)
      .values({
        hash,
        kind: "leaf",
        tsa: t.tsa,
        role: "primary",
        status: "stamped",
        token: Buffer.from(t.token, "base64"),
      })
      .onConflictDoNothing();
  }
  const { timestamps: _t, anchor: _a, ...core } = b;
  await testDb
    .insert(alibis)
    .values({
      purchaseId: b.alibi_id,
      leafHash: hash,
      bundle: {
        ...core,
        timestamps: [],
        paypal: { ...core.paypal, capture_id: undefined, invoice_id: undefined },
      },
      ...(b.anchor ? { anchor: b.anchor } : {}),
    })
    .onConflictDoNothing();
  await testDb
    .insert(disputes)
    .values({
      id,
      purchaseId: b.alibi_id,
      state: "ATTRIBUTED",
      reason: "UNAUTHORISED",
      ruleId: 70,
      liable: 4,
      raw: {},
    })
    .onConflictDoNothing();
  await testDb
    .insert(verdicts)
    .values({
      id: ulid(),
      disputeId: id,
      liable: 4,
      ruleId: 70,
      amountMinor: BigInt(c.amount),
      currency: "USD",
      payee: "0x467D2beBb479D9B80Ab1c461243E05A2b82387d8",
      digest: randomBytes(32),
      chainId: 421614,
      message: { ruleId: "70", liable: "4" },
      signatures: [],
      facts: {
        reason: "UNAUTHORISED",
        proof_valid: true,
        failed_green: false,
        failed_amber: false,
        failed_gray: false,
        captured_eq_countersigned: true,
      },
    })
    .onConflictDoNothing();
}

describe.skipIf(!disputeId || !f)("dispute response (sandbox)", () => {
  const id = disputeId as string;
  let deps: Parameters<typeof respondToDispute>[0];

  beforeAll(async () => {
    deps = {
      db: testDb,
      log,
      paypal: createPayPalDeps({
        PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID ?? "",
        PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET ?? "",
        PAYPAL_ENV: "sandbox",
        PAYPAL_MERCHANT_ID: process.env.PAYPAL_MERCHANT_ID ?? "unused",
      }),
      anthropic: process.env.ANTHROPIC_API_KEY ? new Anthropic() : undefined,
    };
    await seed(id);
  });

  test(
    "answers a friendly-fraud claim with the Alibi and wins it",
    async () => {
      const first = await respondToDispute(deps, id);
      log.info({ first }, "first run");
      expect(first).toMatchObject({ status: "sent", action: "provide_evidence" });
      if (deps.anthropic) expect(first).toMatchObject({ drafted: "model" });

      const again = await respondToDispute(deps, id);
      expect(["already_sent", "waiting"]).toContain(again.status);
      expect(
        await testDb.select().from(disputeResponses).where(eq(disputeResponses.disputeId, id)),
      ).toHaveLength(1);

      const app = createApp({ db: testDb, kv: testKv, log });
      const shown = await (await app.request(`/v1/disputes/${id}`)).json();
      log.info({ responses: shown.responses }, "GET /v1/disputes");
      expect(shown.responses[0]).toMatchObject({
        action: "provide_evidence",
        evidence_types: ["PERMISSION_DESCRIPTION", "ORDER_DETAILS"],
      });

      // The sandbox stands in for PayPal's agent: once the evidence is in, it decides.
      const f = deps.paypal.paypal.fetch;
      let adjudicated = false;
      let requested = false;
      const deadline = Date.now() + 15 * 60_000;
      while (Date.now() < deadline) {
        const d = await getDispute(f, id);
        const rels = new Set(d.links?.map((l) => l.rel));
        log.info(
          { status: d.status, stage: d.dispute_life_cycle_stage, links: [...rels] },
          "dispute",
        );
        if (d.status === "RESOLVED") break;
        if (!adjudicated && rels.has("adjudicate")) {
          await adjudicate(f, id, "SELLER_FAVOR");
          adjudicated = true;
        } else if (!requested && !adjudicated && rels.has("require_evidence")) {
          await requireEvidence(f, id, "SELLER_EVIDENCE");
          requested = true;
        }
        await sleep(5_000);
      }
      const final = (await getDispute(f, id)) as { status: string; dispute_outcome?: unknown };
      log.info({ status: final.status, outcome: final.dispute_outcome }, "final");
      expect(final.status).toBe("RESOLVED");
      expect(final.dispute_outcome).toMatchObject({ outcome_code: "RESOLVED_SELLER_FAVOUR" });
    },
    20 * 60_000,
  );
});
