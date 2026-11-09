import { randomBytes } from "node:crypto";
import { leafHashOf } from "@keelson/alibi";
import {
  alibis,
  disputes,
  mandates,
  operators,
  purchases,
  timestamps,
  user,
  verdicts,
} from "@keelson/db";
import { ulid } from "ulid";
import { fixtures } from "../../../packages/alibi/test/fixtures.ts";
import { testDb } from "./setup.ts";

/** The Alibi fixture disputes are judged on: a real sandbox purchase, anchored on chain. */
export const fixture = fixtures[0];

/**
 * Stores the purchase's Alibi and a user-at-fault verdict (R70: the cart met the mandate) for
 * the dispute, as `evaluateDispute` leaves them, so the response step runs on its own.
 */
export async function seed(
  id: string,
  opts: { verdict?: boolean } = { verdict: true },
): Promise<void> {
  const b = fixture?.bundle as NonNullable<typeof fixture>["bundle"];
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
      countersign: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, String(v)])),
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
  if (!opts.verdict) {
    await testDb
      .insert(disputes)
      .values({ id, purchaseId: b.alibi_id, state: "OPEN", reason: "UNAUTHORISED", raw: {} })
      .onConflictDoNothing();
    return;
  }
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
