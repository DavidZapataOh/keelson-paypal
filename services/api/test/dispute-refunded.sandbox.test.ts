import { randomBytes } from "node:crypto";
import {
  disputeResponses,
  disputes,
  eq,
  mandates,
  operators,
  purchases,
  user,
  verdicts,
} from "@keelson/db";
import { getDispute } from "@keelson/paypal";
import { pino } from "pino";
import { ulid } from "ulid";
import { describe, expect, test } from "vitest";
import { respondToDispute } from "../src/disputes/respond.ts";
import { createPayPalDeps } from "../src/paypal.ts";
import { testDb } from "./setup.ts";

/** A buyer-opened sandbox dispute on which PayPal offers the seller `accept_claim`. */
const disputeId = process.env.PAYPAL_ACCEPT_CLAIM_DISPUTE_ID;

const paypal = () =>
  createPayPalDeps({
    PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID as string,
    PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET as string,
    PAYPAL_ENV: "sandbox",
    PAYPAL_MERCHANT_ID: "A4WCRYD5EYDF2",
  });

/** The dispute stored as attributed to the operator, with the settlement state of `verdict`. */
async function seedOperatorVerdict(
  id: string,
  reason: string,
  verdict: Partial<typeof verdicts.$inferInsert>,
): Promise<void> {
  const userId = ulid();
  await testDb.insert(user).values({ id: userId, name: "Tester", email: `${userId}@example.test` });
  const agentId = BigInt(Date.now());
  await testDb.insert(operators).values({
    agentId,
    chainId: 421614,
    agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
    name: "op",
    cnfJwk: {},
  });
  const mandateId = ulid();
  await testDb.insert(mandates).values({
    id: mandateId,
    userId,
    operatorAgentId: agentId,
    currency: "USD",
    maxMinor: 2_000n,
    remainingMinor: 2_000n,
    merchantIds: ["mrc_runfast"],
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  const purchaseId = ulid();
  await testDb.insert(purchases).values({
    id: purchaseId,
    mandateId,
    merchantId: "mrc_runfast",
    currency: "USD",
    amountMinor: 500n,
    cartHash: randomBytes(32),
    state: "SLASHED",
  });
  await testDb.insert(disputes).values({
    id,
    purchaseId,
    reason,
    raw: {},
    state: "ATTRIBUTED",
  });
  // The operator was at fault and the settlement already refunded the buyer under the verdict.
  await testDb.insert(verdicts).values({
    id: ulid(),
    disputeId: id,
    liable: 1,
    ruleId: 61,
    amountMinor: 500n,
    currency: "USD",
    payee: "0x467D2beBb479D9B80Ab1c461243E05A2b82387d8",
    digest: randomBytes(32),
    chainId: 421614,
    message: {},
    signatures: [],
    facts: {},
    ...verdict,
  });
}

describe.skipIf(!disputeId || !process.env.PAYPAL_CLIENT_ID)(
  "an operator-liable dispute (sandbox)",
  () => {
    test("is not accepted again once the verdict refunded the buyer", async () => {
      const id = disputeId as string;
      const pp = paypal();
      const before = await getDispute(pp.paypal.fetch, id);
      expect(before.links?.map((l) => l.rel)).toContain("accept_claim");
      await seedOperatorVerdict(id, before.reason ?? "UNAUTHORISED", {
        refundId: "REFUNDED-BY-VERDICT",
      });
      const deps = { db: testDb, log: pino({ level: "silent" }), paypal: pp };
      expect(await respondToDispute(deps, id)).toEqual({
        status: "refunded",
        disputeId: id,
        refundId: "REFUNDED-BY-VERDICT",
      });
      expect(
        await testDb.select().from(disputeResponses).where(eq(disputeResponses.disputeId, id)),
      ).toHaveLength(0);
      const after = await getDispute(pp.paypal.fetch, id);
      expect(after.status).toBe(before.status);
      expect(after.links?.map((l) => l.rel)).toContain("accept_claim");
    }, 60_000);

    test("is not accepted when the chain refused to pay the merchant", async () => {
      const id = disputeId as string;
      const pp = paypal();
      const before = await getDispute(pp.paypal.fetch, id);
      // The same dispute, attributed afresh: the earlier test's rows go.
      await testDb.delete(verdicts).where(eq(verdicts.disputeId, id));
      await testDb.delete(disputes).where(eq(disputes.id, id));
      await seedOperatorVerdict(id, before.reason ?? "UNAUTHORISED", {
        outcome: "failed",
        failure: "CoverageNotActive",
      });
      const deps = { db: testDb, log: pino({ level: "silent" }), paypal: pp };
      expect(await respondToDispute(deps, id)).toEqual({
        status: "unsettled",
        disputeId: id,
        failure: "CoverageNotActive",
      });
      expect(
        await testDb.select().from(disputeResponses).where(eq(disputeResponses.disputeId, id)),
      ).toHaveLength(0);
      expect((await getDispute(pp.paypal.fetch, id)).links?.map((l) => l.rel)).toContain(
        "accept_claim",
      );
    }, 60_000);
  },
);
