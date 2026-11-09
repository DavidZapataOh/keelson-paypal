import { randomBytes } from "node:crypto";
import {
  disputeResponses,
  disputes,
  mandates,
  operators,
  paypalEvents,
  purchases,
  transition,
  user,
  verdicts,
} from "@keelson/db";
import { pino } from "pino";
import { ulid } from "ulid";
import { beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { evaluateDispute } from "../src/disputes/evaluate.ts";
import { createPayPalDeps } from "../src/paypal.ts";
import { LegClient } from "../src/tee/client.ts";
import { testDb, testKv } from "./setup.ts";

const log = pino({ level: "silent" });
const app = createApp({ db: testDb, kv: testKv, log });
const disputeId = `PP-D-${randomBytes(4).toString("hex")}`;
const receivedAt = new Date("2026-11-09T12:00:00.000Z");
const attributedAt = new Date("2026-11-09T12:00:04.250Z");
const digest = randomBytes(32);

/** Legs nothing listens on: a run that reached them would fail. */
const unreachable = (leg: "a" | "b") =>
  new LegClient(leg, "http://127.0.0.1:9", "t".repeat(32), 200);

beforeAll(async () => {
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
    amountMinor: 100n,
    cartHash: randomBytes(32),
    state: "DISPUTED",
  });
  await testDb.insert(disputes).values({
    id: disputeId,
    purchaseId,
    reason: "UNAUTHORISED",
    raw: {},
  });
  await testDb.insert(paypalEvents).values({
    id: `WH-${randomBytes(6).toString("hex")}`,
    eventType: "CUSTOMER.DISPUTE.CREATED",
    resourceType: "dispute",
    resourceId: disputeId,
    source: "poll",
    body: Buffer.from("{}"),
    receivedAt,
    disputeId,
  });
});

describe("GET /v1/disputes/{id}", () => {
  test("an open dispute has no verdict and no timer yet", async () => {
    const res = await app.request(`/v1/disputes/${disputeId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      dispute_id: disputeId,
      state: "OPEN",
      received_at: receivedAt.toISOString(),
      attributed_at: null,
      elapsed_ms: null,
      liable: null,
      verdict: null,
    });
    expect(body.parties.map((p: { party: string }) => p.party)).toEqual([
      "operator",
      "keelson",
      "merchant",
    ]);
  });

  test("an attributed dispute names the party at fault and the time it took", async () => {
    await testDb.insert(verdicts).values({
      id: ulid(),
      disputeId,
      liable: 1,
      ruleId: 61,
      amountMinor: 100n,
      currency: "USD",
      payee: "0x467D2beBb479D9B80Ab1c461243E05A2b82387d8",
      digest,
      chainId: 421614,
      message: { ruleId: "61", liable: "1" },
      signatures: [],
      facts: { reason: "UNAUTHORISED", failed_amber: true },
      createdAt: attributedAt,
    });
    await transition(testDb, "disputes", disputeId, "OPEN", "ATTRIBUTED", {
      ruleId: 61,
      liable: 1,
    });
    const body = await (await app.request(`/v1/disputes/${disputeId}`)).json();
    expect(body).toMatchObject({
      state: "ATTRIBUTED",
      attributed_at: attributedAt.toISOString(),
      elapsed_ms: 4_250,
      liable: "operator",
      verdict: { rule: "R61", digest: `0x${digest.toString("hex")}`, chain_id: 421614 },
    });
    expect(body.parties).toEqual([
      { party: "operator", liable: true },
      { party: "keelson", liable: false },
      { party: "merchant", liable: false },
    ]);
  });

  test("lists what was sent to PayPal, without the statement's text", async () => {
    await testDb.insert(disputeResponses).values({
      id: ulid(),
      disputeId,
      action: "provide_evidence",
      stage: "CHARGEBACK",
      dueDate: "2026-11-16T04:59:59.000Z",
      input: {
        evidences: [
          { evidence_type: "PERMISSION_DESCRIPTION", notes: "n" },
          { evidence_type: "ORDER_DETAILS", notes: "n", documents: [{ name: "alibi.pdf" }] },
        ],
      },
      draft: {
        source: "model",
        statement: "The buyer signed a mandate[1].",
        citations: [{ text: "Max amount", document: "Alibi", pages: [1, 1] }],
      },
    });
    const body = await (await app.request(`/v1/disputes/${disputeId}`)).json();
    expect(body.responses).toEqual([
      {
        action: "provide_evidence",
        stage: "CHARGEBACK",
        evidence_types: ["PERMISSION_DESCRIPTION", "ORDER_DETAILS"],
        drafted_by: "model",
        citations: 1,
        sent_at: expect.any(String),
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("signed a mandate");
  });

  test("PayPal's PP-R ids are routed", async () => {
    expect((await app.request("/v1/disputes/PP-R-OII-0")).status).toBe(404);
  });

  test("a dispute Keelson does not know is not found", async () => {
    expect((await app.request("/v1/disputes/PP-D-0")).status).toBe(404);
  });
});

describe("evaluateDispute", () => {
  test("answers a stored verdict again without asking the legs", async () => {
    const out = await evaluateDispute(
      {
        db: testDb,
        kv: testKv,
        log,
        paypal: createPayPalDeps({
          PAYPAL_CLIENT_ID: "unused",
          PAYPAL_CLIENT_SECRET: "unused",
          PAYPAL_ENV: "sandbox",
          PAYPAL_MERCHANT_ID: "unused",
        }),
        tee: { client: { a: unreachable("a"), b: unreachable("b") } },
        chain: { client: undefined as never },
        tlog: { url: "http://127.0.0.1:9", token: "t".repeat(32) },
      },
      disputeId,
    );
    expect(out).toEqual({
      status: "attributed",
      disputeId,
      ruleId: 61,
      liable: 1,
      digest: `0x${digest.toString("hex")}`,
    });
  });

  test("a dispute it never stored is unknown", async () => {
    const out = await evaluateDispute(
      { db: testDb } as Parameters<typeof evaluateDispute>[0],
      "PP-D-unknown",
    );
    expect(out).toEqual({ status: "unknown", disputeId: "PP-D-unknown" });
  });
});
