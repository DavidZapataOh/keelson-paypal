// Loads reflect-metadata before @keelson/alibi/verify pulls in @keelson/attest (see tee/attest.ts).
import "../src/tee/attest.ts";
import { randomBytes } from "node:crypto";
import {
  cardChargebacks,
  disputes,
  eq,
  mandates,
  operators,
  purchaseCards,
  purchases,
  user,
  verdicts,
} from "@keelson/db";
import { pino } from "pino";
import { ulid } from "ulid";
import type { PublicClient } from "viem";
import { describe, expect, test } from "vitest";
import { type EvaluateDeps, evaluateDispute } from "../src/disputes/evaluate.ts";
import { settleDispute, userReceiver } from "../src/disputes/settle.ts";
import { KEELSON_TREASURY } from "../src/merchants.ts";
import { testDb, testKv } from "./setup.ts";

const log = pino({ level: "silent" });
const chain = { client: {} as PublicClient };

/** A captured card purchase of a user, disputed by a chargeback in `status`. */
async function disputed(status: string, email = `u-${ulid()}@example.test`) {
  const userId = `user-${ulid()}`;
  await testDb.insert(user).values({ id: userId, name: "Buyer", email, emailVerified: true });
  const agentId = BigInt(`0x${randomBytes(12).toString("hex")}`);
  await testDb.insert(operators).values({
    agentId,
    chainId: 421614,
    agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
    name: "op",
    cnfJwk: {},
  });
  const mid = ulid();
  await testDb.insert(mandates).values({
    id: mid,
    userId,
    operatorAgentId: agentId,
    state: "ACTIVE",
    rail: "card",
    currency: "USD",
    maxMinor: 10_000n,
    remainingMinor: 9_550n,
    merchantIds: ["*"],
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  const id = ulid();
  await testDb.insert(purchases).values({
    id,
    mandateId: mid,
    state: "DISPUTED",
    rail: "card",
    merchantId: "*",
    currency: "USD",
    amountMinor: 450n,
    cartHash: randomBytes(32),
    countersign: { requestId: `0x${"00".repeat(32)}` },
  });
  await testDb.insert(purchaseCards).values({
    purchaseId: id,
    issuer: "lithic",
    cardToken: `card-${ulid()}`,
    lastFour: "4242",
    controls: {},
    state: "CLOSED",
    expiresAt: new Date(),
    transactionToken: `txn-${ulid()}`,
    settledMinor: 450n,
  });
  const token = `dsp-${ulid()}`;
  await testDb.insert(cardChargebacks).values({
    id: token,
    purchaseId: id,
    reason: "not_received",
    amountMinor: 450n,
    status,
  });
  await testDb
    .insert(disputes)
    .values({ id: token, purchaseId: id, reason: "GOODS_SERVICES_NOT_RECEIVED", raw: {} });
  return { id, token };
}

describe("card disputes", () => {
  test("are not attributed while their chargeback is being decided", async () => {
    const { token } = await disputed("SUBMITTED");
    const out = await evaluateDispute(
      { db: testDb, kv: testKv, log, chain } as unknown as EvaluateDeps,
      token,
    );
    expect(out).toEqual({ status: "waiting", disputeId: token });
  });

  test("a chargeback that returned everything leaves the bond untouched", async () => {
    const { id, token } = await disputed("CASE_WON");
    await testDb.update(purchases).set({ state: "ATTRIBUTED" }).where(eq(purchases.id, id));
    await testDb.insert(verdicts).values({
      id: ulid(),
      disputeId: token,
      liable: 1,
      ruleId: 61,
      amountMinor: 0n,
      currency: "USD",
      payee: KEELSON_TREASURY,
      rail: "card",
      digest: randomBytes(32),
      chainId: 421614,
      message: {},
      signatures: [],
      facts: {},
    });
    const out = await settleDispute({ db: testDb, log, chain }, token);
    expect(out).toEqual({ status: "none", disputeId: token });
    const [p] = await testDb.select().from(purchases).where(eq(purchases.id, id));
    expect(p?.state).toBe("MERCHANT_LIABLE");
  });

  test("the user is paid at the PayPal account they signed in with, never a judge's", async () => {
    const paid = await disputed("CASE_CLOSED", "buyer@example.test");
    expect(await userReceiver(testDb, paid.id)).toBe("buyer@example.test");
    const judge = await disputed("CASE_CLOSED", `anon-${ulid()}@judge.keelson.finance`);
    expect(await userReceiver(testDb, judge.id)).toBeNull();
  });
});
