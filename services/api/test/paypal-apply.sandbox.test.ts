import { randomBytes } from "node:crypto";
import { DST, hashObject } from "@keelson/core";
import { disputes, eq, mandates, operators, paypalEvents, purchases, user } from "@keelson/db";
import {
  createPayPal,
  eventResourceId,
  getDispute,
  holdOrderRequest,
  ids,
  listWebhookEvents,
  paypalConfig,
  TokenCache,
  type WebhookEvent,
} from "@keelson/paypal";
import { approveOrder, CANCEL_URL, payerActionUrl, RETURN_URL } from "@keelson/paypal/testing";
import { pino } from "pino";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type ApplyDeps, applyDispute } from "../src/paypal/apply.ts";
import { pollOnce } from "../src/paypal/poll.ts";
import { storeDelivery } from "../src/paypal/webhook.ts";
import { type PayPalEventWorker, startPayPalEventWorker } from "../src/paypal/worker.ts";
import { call, type PayPalDeps } from "../src/paypal.ts";
import { sandbox } from "./hold-live.ts";
import { testDb, testKv } from "./setup.ts";
import { live } from "./tee-live.ts";

const log = pino({ level: "silent" });
const usd = (minor: bigint) => ({ currencyCode: "USD", value: (Number(minor) / 100).toFixed(2) });

let paypal: PayPalDeps;
let deps: ApplyDeps;
const started: string[] = [];
let operatorId: bigint;
const t0 = new Date(Date.now() - 60_000);

async function mandate(values: Partial<typeof mandates.$inferInsert>): Promise<string> {
  const id = ulid();
  await testDb.insert(mandates).values({
    id,
    userId: "apply-user",
    operatorAgentId: operatorId,
    currency: "USD",
    maxMinor: 2_000n,
    remainingMinor: 2_000n,
    merchantIds: ["m"],
    expiresAt: new Date(Date.now() + 86_400_000),
    ...values,
  });
  return id;
}

async function purchase(values: Partial<typeof purchases.$inferInsert> & { mandateId: string }) {
  const id = values.id ?? ulid();
  await testDb.insert(purchases).values({
    id,
    merchantId: "m",
    currency: "USD",
    amountMinor: 100n,
    cartHash: randomBytes(32),
    ...values,
  });
  return id;
}

/** A real AUTHORIZE order the sandbox buyer approved, authorized through the SDK. */
async function authorized(minor: bigint): Promise<{ orderId: string; authorizationId: string }> {
  const mid = ulid();
  const mandateHash = hashObject(DST.mandate, { mandate_id: mid, nonce: ulid() });
  const order = await call(
    paypal.paypal.orders.createOrder(
      holdOrderRequest({
        env: "s",
        mid,
        mandateHash,
        amount: { currency: "USD", minor },
        returnUrl: RETURN_URL,
        cancelUrl: CANCEL_URL,
      }),
    ),
  );
  await approveOrder(payerActionUrl(order));
  const orderId = order.id as string;
  const result = await call(
    paypal.paypal.orders.authorizeOrder({
      id: orderId,
      paypalRequestId: ids.operationRequestId(orderId, "authorize"),
    }),
  );
  const authorizationId = result.purchaseUnits?.[0]?.payments?.authorizations?.[0]?.id as string;
  return { orderId, authorizationId };
}

async function capture(authorizationId: string, purchaseId: string, seq: number, minor: bigint) {
  const digest = hashObject(DST.alibi, { purchase: purchaseId });
  const invoiceId = ids.encodeInvoiceId(purchaseId, seq, digest);
  const c = await call(
    paypal.paypal.payments.captureAuthorizedPayment({
      authorizationId,
      paypalRequestId: ids.requestIdFromDigest(digest),
      body: { amount: usd(minor), invoiceId, finalCapture: false },
    }),
  );
  return { captureId: c.id as string, invoiceId };
}

/** PayPal's own events about a resource, stored the way the poller stores them. */
async function events(resourceId: string, type: string): Promise<WebhookEvent[]> {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const listed = await listWebhookEvents(paypal.paypal.fetch, {
      startTime: t0,
      endTime: new Date(),
    });
    const found = listed.filter((e) => e.event_type === type && eventResourceId(e) === resourceId);
    if (found.length > 0) return found;
    if (Date.now() > deadline) throw new Error(`no ${type} event for ${resourceId}`);
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

async function store(event: WebhookEvent): Promise<void> {
  await storeDelivery(
    { db: testDb },
    {
      eventId: event.id,
      eventType: event.event_type,
      resourceType: event.resource_type,
      resourceId: eventResourceId(event),
    },
    new TextEncoder().encode(JSON.stringify(event)),
  );
}

const eventRow = async (id: string) =>
  (await testDb.select().from(paypalEvents).where(eq(paypalEvents.id, id)))[0];

async function settled(
  id: string,
  worker: PayPalEventWorker,
): Promise<typeof paypalEvents.$inferSelect> {
  worker.wake();
  const deadline = Date.now() + 60_000;
  for (;;) {
    const row = await eventRow(id);
    if (row && row.status !== "received" && row.status !== "inflight") return row;
    if (Date.now() > deadline) throw new Error(`event ${id} not settled: ${row?.status}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const mandateState = async (id: string) =>
  (await testDb.select().from(mandates).where(eq(mandates.id, id)))[0];
const purchaseRow = async (id: string) =>
  (await testDb.select().from(purchases).where(eq(purchases.id, id)))[0];

describe.runIf(live)("PayPal events applied from a re-read (sandbox)", () => {
  let worker: PayPalEventWorker;

  beforeAll(async () => {
    paypal = sandbox();
    deps = {
      db: testDb,
      kv: testKv,
      log,
      paypal,
      startDisputeWorkflow: async (id) => {
        started.push(id);
      },
    };
    await testDb
      .insert(user)
      .values({ id: "apply-user", name: "Tester", email: "apply@example.test" })
      .onConflictDoNothing();
    const [op] = await testDb
      .insert(operators)
      .values({
        agentId: BigInt(`0x${randomBytes(12).toString("hex")}`),
        chainId: 421614,
        agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
        name: "op",
        cnfJwk: {},
      })
      .returning();
    operatorId = (op as { agentId: bigint }).agentId;
    worker = startPayPalEventWorker(deps, { sweepIntervalMs: 500 });
  }, 60_000);

  afterAll(async () => {
    await worker?.stop();
  });

  test("captures, a mismatch and a refund are applied from what PayPal answers", async () => {
    const hold = await authorized(2_000n);
    const mid = await mandate({
      state: "ACTIVE",
      paypalOrderId: hold.orderId,
      paypalAuthorizationId: hold.authorizationId,
      paypalParentAuthorizationId: hold.authorizationId,
    });
    const p1 = ulid();
    const p2 = ulid();
    const c1 = await capture(hold.authorizationId, p1, 1, 500n);
    // Countersigned one cent more than PayPal captured.
    const c2 = await capture(hold.authorizationId, p2, 2, 300n);
    await purchase({
      id: p1,
      mandateId: mid,
      amountMinor: 500n,
      state: "COVERED",
      invoiceId: c1.invoiceId,
    });
    await purchase({
      id: p2,
      mandateId: mid,
      amountMinor: 301n,
      state: "COVERED",
      invoiceId: c2.invoiceId,
    });

    const [e1] = await events(c1.captureId, "PAYMENT.CAPTURE.COMPLETED");
    const [e2] = await events(c2.captureId, "PAYMENT.CAPTURE.COMPLETED");
    await store(e1 as WebhookEvent);
    await store(e2 as WebhookEvent);

    const r1 = await settled((e1 as WebhookEvent).id, worker);
    expect(r1).toMatchObject({ status: "applied", purchaseId: p1, attempts: 1 });
    expect(r1.resourceReadAt).not.toBeNull();
    expect(await purchaseRow(p1)).toMatchObject({
      state: "CAPTURED",
      paypalCaptureId: c1.captureId,
    });
    expect((await mandateState(mid))?.remainingMinor).toBe(1_500n);

    const r2 = await settled((e2 as WebhookEvent).id, worker);
    expect(r2).toMatchObject({ status: "mismatch", purchaseId: p2 });
    expect((await purchaseRow(p2))?.state).toBe("COVERED");

    const refund = await call(
      paypal.paypal.payments.refundCapturedPayment({
        captureId: c1.captureId,
        body: { amount: usd(100n) },
      }),
    );
    const [e3] = await events(refund.id as string, "PAYMENT.CAPTURE.REFUNDED");
    await store(e3 as WebhookEvent);
    const r3 = await settled((e3 as WebhookEvent).id, worker);
    expect(r3).toMatchObject({ status: "applied", purchaseId: p1 });
    expect(await purchaseRow(p1)).toMatchObject({
      state: "CAPTURED",
      captureStatus: "PARTIALLY_REFUNDED",
    });

    // Applying the capture again changes nothing more.
    await testDb
      .update(paypalEvents)
      .set({ status: "received", attempts: 0 })
      .where(eq(paypalEvents.id, (e1 as WebhookEvent).id));
    expect((await settled((e1 as WebhookEvent).id, worker)).status).toBe("applied");
    expect((await mandateState(mid))?.remainingMinor).toBe(1_500n);
  }, 600_000);

  test("an authorization voided before its CREATED event is applied ends the hold, never activates it", async () => {
    const pending = await authorized(1_000n);
    const mid = await mandate({
      state: "HOLD_PENDING",
      maxMinor: 1_000n,
      remainingMinor: 1_000n,
      paypalOrderId: pending.orderId,
    });
    await call(paypal.paypal.payments.voidPayment({ authorizationId: pending.authorizationId }));
    const [created] = await events(pending.authorizationId, "PAYMENT.AUTHORIZATION.CREATED");
    await store(created as WebhookEvent);
    const r = await settled((created as WebhookEvent).id, worker);
    expect(r).toMatchObject({ status: "applied", mandateId: mid });
    expect(await mandateState(mid)).toMatchObject({ state: "EXPIRED", holdError: "paypal:VOIDED" });

    // A void made outside Keelson of an active hold.
    const active = await authorized(1_000n);
    const mid2 = await mandate({
      state: "ACTIVE",
      maxMinor: 1_000n,
      remainingMinor: 1_000n,
      paypalOrderId: active.orderId,
      paypalAuthorizationId: active.authorizationId,
      paypalParentAuthorizationId: active.authorizationId,
    });
    await call(paypal.paypal.payments.voidPayment({ authorizationId: active.authorizationId }));
    const [voided] = await events(active.authorizationId, "PAYMENT.AUTHORIZATION.VOIDED");
    await store(voided as WebhookEvent);
    expect(await settled((voided as WebhookEvent).id, worker)).toMatchObject({
      status: "applied",
      mandateId: mid2,
    });
    expect((await mandateState(mid2))?.state).toBe("EXPIRED");
  }, 600_000);

  test("an event about a resource Keelson does not hold is ignored", async () => {
    const other = await authorized(500n);
    const [created] = await events(other.authorizationId, "PAYMENT.AUTHORIZATION.CREATED");
    await store(created as WebhookEvent);
    expect((await settled((created as WebhookEvent).id, worker)).status).toBe("ignored");
    await call(paypal.paypal.payments.voidPayment({ authorizationId: other.authorizationId }));
  }, 300_000);

  test("disputes are stored from the re-read, the open one disputes its purchase and is handed on", async () => {
    const cfg = paypalConfig();
    const f = createPayPal(cfg, new TokenCache(cfg)).fetch;
    const [openId] = await listOpen(f);
    const open = openId ? await getDispute(f, openId) : undefined;
    const resolved = await getDispute(f, process.env.PAYPAL_SANDBOX_DISPUTE_ID as string);
    expect(resolved.status).toBe("RESOLVED");
    for (const d of [resolved, ...(open ? [open] : [])]) {
      const t = d.disputed_transactions?.[0];
      const parsed = t?.invoice_number ? ids.parseInvoiceId(t.invoice_number) : null;
      const mid = await mandate({ state: "ACTIVE" });
      await purchase({
        id: parsed?.id ?? ulid(),
        mandateId: mid,
        state: "CAPTURED",
        invoiceId: t?.invoice_number ?? null,
        paypalCaptureId: t?.seller_transaction_id ?? null,
      });
    }

    const r = await applyDispute(deps, resolved, "CUSTOMER.DISPUTE.RESOLVED");
    expect(r.status).toBe("applied");
    const [row] = await testDb.select().from(disputes).where(eq(disputes.id, resolved.dispute_id));
    expect(row).toMatchObject({ state: "RESOLVED", purchaseId: r.purchaseId });
    expect(row?.raw).toEqual(resolved);
    // First seen resolved: the purchase is left as it was.
    expect((await purchaseRow(r.purchaseId as string))?.state).toBe("CAPTURED");
    expect(started).not.toContain(resolved.dispute_id);

    if (open) {
      const o = await applyDispute(deps, open, "CUSTOMER.DISPUTE.CREATED");
      expect(o.status).toBe("applied");
      expect(started.filter((id) => id === open.dispute_id)).toHaveLength(1);
      expect((await purchaseRow(o.purchaseId as string))?.state).toBe("DISPUTED");
      const [orow] = await testDb.select().from(disputes).where(eq(disputes.id, open.dispute_id));
      expect(orow?.state).toBe("OPEN");
    }
  }, 120_000);

  test("PayPal unreachable leaves the event received with a backoff, and the poller skips the round", async () => {
    const cfg = paypalConfig();
    const down: PayPalDeps = {
      ...paypal,
      paypal: createPayPal(cfg, new TokenCache({ ...cfg, baseUrl: "https://127.0.0.1:9" })),
    };
    const [anyEvent] = await listWebhookEvents(paypal.paypal.fetch, {
      startTime: t0,
      endTime: new Date(),
    });
    const event = anyEvent as WebhookEvent;
    const copy = { ...event, id: `${event.id}` };
    await testDb.delete(paypalEvents).where(eq(paypalEvents.id, copy.id));
    await store(copy);
    await worker.stop();
    const before = Date.now();
    const downWorker = startPayPalEventWorker(
      { ...deps, paypal: down },
      { sweepIntervalMs: 60_000 },
    );
    try {
      const deadline = Date.now() + 30_000;
      let row = await eventRow(copy.id);
      while ((row?.attempts ?? 0) < 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
        row = await eventRow(copy.id);
      }
      expect(row).toMatchObject({ status: "received", attempts: 1 });
      const wait = (row?.nextAttemptAt.getTime() ?? 0) - before;
      expect(wait).toBeGreaterThan(1_500);
      expect(wait).toBeLessThan(20_000);
    } finally {
      await downWorker.stop();
    }
    await expect(pollOnce({ ...deps, paypal: down })).rejects.toThrow();
  }, 120_000);

  test("two workers on one database apply each event once", async () => {
    const listed = await listWebhookEvents(paypal.paypal.fetch, {
      startTime: t0,
      endTime: new Date(),
    });
    const fresh = listed.filter((e) => e.event_type.startsWith("PAYMENT.AUTHORIZATION"));
    await testDb.delete(paypalEvents);
    for (const e of fresh) await store(e);
    const a = startPayPalEventWorker(deps, { sweepIntervalMs: 200 });
    const b = startPayPalEventWorker(deps, { sweepIntervalMs: 200 });
    try {
      const deadline = Date.now() + 120_000;
      for (;;) {
        const rows = await testDb.select().from(paypalEvents);
        if (rows.every((r) => r.status !== "received" && r.status !== "inflight")) {
          expect(rows.every((r) => r.attempts === 1)).toBe(true);
          break;
        }
        if (Date.now() > deadline) throw new Error("events not applied");
        await new Promise((r) => setTimeout(r, 250));
      }
    } finally {
      await Promise.all([a.stop(), b.stop()]);
    }
  }, 180_000);
});

/** Disputes the sandbox account has, newest first; the list takes only recent windows. */
async function listOpen(f: PayPalDeps["paypal"]["fetch"]): Promise<string[]> {
  const res = await f<{ items?: { dispute_id: string; status: string }[] }>(
    "GET",
    "/v1/customer/disputes",
    { query: { start_time: new Date(Date.now() - 30 * 86_400_000).toISOString() } },
  );
  return (res.items ?? []).filter((d) => d.status !== "RESOLVED").map((d) => d.dispute_id);
}
