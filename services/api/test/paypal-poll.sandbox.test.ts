import { DST, hashObject } from "@keelson/core";
import { eq, paypalEvents } from "@keelson/db";
import { holdOrderRequest, ids } from "@keelson/paypal";
import { approveOrder, CANCEL_URL, payerActionUrl, RETURN_URL } from "@keelson/paypal/testing";
import { pino } from "pino";
import { ulid } from "ulid";
import { beforeAll, describe, expect, test } from "vitest";
import type { ApplyDeps } from "../src/paypal/apply.ts";
import { pollOnce, startPayPalPoller } from "../src/paypal/poll.ts";
import { startPayPalEventWorker } from "../src/paypal/worker.ts";
import { call } from "../src/paypal.ts";
import { sandbox } from "./hold-live.ts";
import { testDb, testKv } from "./setup.ts";
import { live } from "./tee-live.ts";

const log = pino({ level: "silent" });
let deps: ApplyDeps;

async function rounds(): Promise<number> {
  return Number((await testKv.get("paypal:poll:rounds")) ?? 0);
}

describe.runIf(live)("PayPal poller (sandbox)", () => {
  beforeAll(async () => {
    deps = { db: testDb, kv: testKv, log, paypal: sandbox() };
    await testKv.del(["paypal:poll:events", "paypal:poll:disputes"]);
  });

  test("an event no webhook delivered here is stored from the event list and applied", async () => {
    const { paypal } = deps.paypal;
    const mid = ulid();
    const order = await call(
      paypal.orders.createOrder(
        holdOrderRequest({
          env: "s",
          mid,
          mandateHash: hashObject(DST.mandate, { mandate_id: mid }),
          amount: { currency: "USD", minor: 500n },
          returnUrl: RETURN_URL,
          cancelUrl: CANCEL_URL,
        }),
      ),
    );
    await approveOrder(payerActionUrl(order));
    const authorized = await call(
      paypal.orders.authorizeOrder({
        id: order.id as string,
        paypalRequestId: ids.operationRequestId(order.id as string, "authorize"),
      }),
    );
    const authorizationId = authorized.purchaseUnits?.[0]?.payments?.authorizations?.[0]
      ?.id as string;
    const createdAt = Date.now();
    await call(paypal.payments.voidPayment({ authorizationId }));

    const worker = startPayPalEventWorker(deps, { sweepIntervalMs: 500 });
    const poller = startPayPalPoller({ ...deps, paypalEvents: worker }, { intervalMs: 2_000 });
    try {
      const deadline = Date.now() + 180_000;
      let row: typeof paypalEvents.$inferSelect | undefined;
      for (;;) {
        [row] = await testDb
          .select()
          .from(paypalEvents)
          .where(eq(paypalEvents.resourceId, authorizationId));
        if (row && row.status !== "received" && row.status !== "inflight") break;
        if (Date.now() > deadline) throw new Error("the poller did not store the event");
        await new Promise((r) => setTimeout(r, 1_000));
      }
      expect(row).toMatchObject({ source: "poll", transmissionId: null, status: "ignored" });
      console.info(`authorization created → polled: ${row.receivedAt.getTime() - createdAt} ms`);
    } finally {
      await poller.stop();
      await worker.stop();
    }

    const before = (await testDb.select({ id: paypalEvents.id }).from(paypalEvents)).length;
    const cursor = await testKv.get("paypal:poll:events");
    expect(await pollOnce(deps)).toBe(true);
    expect((await testDb.select({ id: paypalEvents.id }).from(paypalEvents)).length).toBe(before);
    expect(new Date((await testKv.get("paypal:poll:events")) as string).getTime()).toBeGreaterThan(
      new Date(cursor as string).getTime(),
    );
  }, 600_000);

  test("two pollers on one database run one round at a time", async () => {
    const start = await rounds();
    const results = await Promise.all([pollOnce(deps), pollOnce(deps)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await rounds()) - start).toBe(1);
  }, 120_000);
});
