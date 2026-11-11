import { randomBytes } from "node:crypto";
import { disputes, mandates, operators, purchaseHolds, purchases, user } from "@keelson/db";
import { pino } from "pino";
import { ulid } from "ulid";
import { beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { publishPurchase } from "../src/pipeline/events.ts";
import { principalChannel } from "../src/principal.ts";
import { testDb, testKv } from "./setup.ts";
import { asUser, headerPrincipal } from "./tee-live.ts";

const app = createApp({
  db: testDb,
  kv: testKv,
  log: pino({ level: "silent" }),
  authenticate: headerPrincipal,
});
const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers });

const owner = `user-${randomBytes(6).toString("hex")}`;
const other = `user-${randomBytes(6).toString("hex")}`;
const agentId = BigInt(`0x${randomBytes(6).toString("hex")}`);
const [older, newer] = [ulid(), ulid()];
const [captured, failed, denied] = [ulid(), ulid(), ulid()];
const disputeId = `PP-D-${randomBytes(4).toString("hex")}`;
const [waiting, authorized] = [ulid(), ulid()];

const mandate = (id: string, userId: string, createdAt: Date) => ({
  id,
  userId,
  operatorAgentId: agentId,
  state: "ACTIVE" as const,
  currency: "USD",
  maxMinor: 10_000n,
  remainingMinor: 6_000n,
  merchantIds: ["store"],
  expiresAt: new Date(Date.now() + 86_400_000),
  createdAt,
});

const purchase = (id: string, mandateId: string, createdAt: Date) => ({
  id,
  mandateId,
  merchantId: "store",
  currency: "USD",
  amountMinor: 4_000n,
  cartHash: randomBytes(32),
  createdAt,
});

beforeAll(async () => {
  for (const id of [owner, other]) {
    await testDb.insert(user).values({ id, name: "Tester", email: `${id}@example.test` });
  }
  await testDb.insert(operators).values({
    agentId,
    chainId: 421614,
    agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
    name: "op",
    cnfJwk: {},
  });
  await testDb
    .insert(mandates)
    .values([
      mandate(older, owner, new Date(Date.now() - 60_000)),
      mandate(newer, owner, new Date()),
      mandate(ulid(), other, new Date()),
    ]);
  await testDb.insert(purchases).values([
    {
      ...purchase(captured, newer, new Date(Date.now() - 30_000)),
      state: "CAPTURED",
      logIndex: 7n,
      invoiceId: `inv-${captured}`,
      paypalCaptureId: `cap-${captured}`,
      captureStatus: "COMPLETED",
    },
    {
      ...purchase(failed, newer, new Date()),
      state: "FAILED",
      failureReason: "capture:declined",
    },
    {
      ...purchase(denied, older, new Date()),
      state: "DENIED",
      // The engine's keelson.eval/1 trace: policy id, mandate field, cart value, mandate value.
      evalTrace: {
        fields: [
          {
            id: "amount",
            field: "total",
            color: "green",
            pass: false,
            observed: 34000,
            bound: 10000,
          },
          {
            id: "budget",
            field: "budget",
            color: "green",
            pass: false,
            observed: 34000,
            bound: 6000,
          },
          {
            id: "merchant",
            field: "merchant",
            color: "green",
            pass: true,
            observed: "store",
            bound: ["store"],
          },
          {
            id: "variant",
            field: "variant",
            color: "amber",
            pass: false,
            observed: [{ sku: "sku-trail", size: "11" }],
            bound: [{ sku: "sku-trail", size: "10", color: "any" }],
          },
          {
            id: "window",
            field: "deadline",
            color: "green",
            pass: false,
            observed: 1_794_700_800_000,
            bound: { expires_at_ms: 1_794_614_399_000, not_before_ms: 1_794_024_122_000 },
          },
        ],
      },
    },
  ]);
  await testDb.insert(purchaseHolds).values(
    [
      [waiting, "PENDING"],
      [authorized, "AUTHORIZED"],
    ].map(([requestId, state]) => ({
      requestId: requestId as string,
      mandateId: newer,
      merchantId: "store",
      currency: "USD",
      amountMinor: 2_500n,
      cartHash: randomBytes(32),
      paypalOrderId: `ord-${requestId}`,
      state: state as "PENDING" | "AUTHORIZED",
    })),
  );
  await testDb.insert(disputes).values({
    id: disputeId,
    purchaseId: captured,
    reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
    raw: {},
  });
});

describe("GET /v1/mandates", () => {
  test("lists the session user's mandates, newest first", async () => {
    const res = await get("/v1/mandates", asUser(owner));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mandates: { id: string }[] };
    expect(body.mandates.map((m) => m.id)).toEqual([newer, older]);
    expect(body.mandates[0]).toMatchObject({
      state: "ACTIVE",
      budget: { currency: "USD", maxMinor: "10000", remainingMinor: "6000" },
      merchantIds: ["store"],
    });
  });

  test("needs a session", async () => {
    expect((await get("/v1/mandates")).status).toBe(401);
  });
});

describe("GET /v1/mandates/{id}", () => {
  test("carries the budget and the purchases with their disputes, newest first", async () => {
    const res = await get(`/v1/mandates/${newer}`, asUser(owner));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown> & {
      purchases: Record<string, unknown>[];
    };
    expect(body.budget).toEqual({ currency: "USD", maxMinor: "10000", remainingMinor: "6000" });
    expect(body.purchases.map((p) => p.id)).toEqual([failed, captured]);
    expect(body.purchases[0]).toMatchObject({
      state: "FAILED",
      failure: { step: "capture", reason: "declined" },
      disputes: [],
    });
    expect(body.purchases[1]).toMatchObject({
      state: "CAPTURED",
      merchantId: "store",
      amount: { currency: "USD", minor: "4000" },
      logIndex: "7",
      capture: { id: `cap-${captured}`, status: "COMPLETED" },
      disputes: [{ id: disputeId, state: "OPEN" }],
    });
  });

  test("carries the purchase holds still waiting for the buyer's approval", async () => {
    const res = await get(`/v1/mandates/${newer}`, asUser(owner));
    const body = (await res.json()) as { pendingHolds: unknown[] };
    expect(body.pendingHolds).toEqual([
      { requestId: waiting, orderId: `ord-${waiting}`, merchant: "store", amountMinor: "2500" },
    ]);
  });

  test("a blocked cart names each failed field with what the mandate allowed and what the cart had", async () => {
    const res = await get(`/v1/mandates/${older}`, asUser(owner));
    const body = (await res.json()) as { purchases: Record<string, unknown>[] };
    expect(body.purchases[0]).toMatchObject({
      id: denied,
      state: "DENIED",
      blocked: ["total", "budget", "variant", "deadline"],
      reasons: [
        { field: "total", mandate: "$100.00", cart: "$340.00" },
        { field: "budget", mandate: "$60.00", cart: "$340.00" },
        { field: "variant", mandate: "size 10, color any", cart: "size 11" },
        { field: "deadline", mandate: "Nov 13, 2026", cart: "Nov 15, 2026" },
      ],
    });
    expect(body.purchases[0]).not.toHaveProperty("failure");
  });

  test("another user's mandate is not found", async () => {
    expect((await get(`/v1/mandates/${newer}`, asUser(other))).status).toBe(404);
  });
});

test("a purchase event also reaches the owner's mandate channel", async () => {
  await publishPurchase({ db: testDb, kv: testKv }, captured, { type: "purchase.captured" });
  const channel = principalChannel({ kind: "user", subject: owner }, `mandate:${newer}`);
  const rows = await testDb.query.events.findMany({
    where: (row, { eq }) => eq(row.channel, channel),
  });
  expect(rows.map((r) => r.payload)).toContainEqual({
    type: "purchase.captured",
    purchaseId: captured,
    mandateId: newer,
  });
});
