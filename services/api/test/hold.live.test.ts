import { randomBytes } from "node:crypto";
import { toPayPalValue } from "@keelson/core";
import { eq, events } from "@keelson/db";
import { holdCustomId, holdOrderRequest } from "@keelson/paypal";
import { CANCEL_URL, RETURN_URL } from "@keelson/paypal/testing";
import { pino } from "pino";
import { describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { call } from "../src/paypal.ts";
import { principalChannel } from "../src/principal.ts";
import { APP_ORIGIN, holdHarness, row, STORE, sandbox } from "./hold-live.ts";
import { testDb, testKv } from "./setup.ts";
import { asUser, headerPrincipal, live } from "./tee-live.ts";

const BUDGET = 10_000n;

const percentile = (xs: number[], p: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;
};

/** Reads server-sent events from a streamed response. */
class Sse {
  private buffer = "";
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();

  constructor(res: Response) {
    expect(res.status).toBe(200);
    this.reader = (res.body as ReadableStream<Uint8Array>).getReader();
  }

  /** The `data` of the next event, skipping comments. */
  async data(timeoutMs = 10_000): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const end = this.buffer.indexOf("\n\n");
      if (end >= 0) {
        const frame = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        const data = frame.split("\n").find((l) => l.startsWith("data:"));
        if (data) return JSON.parse(data.slice(5));
        continue;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("no event received");
      let timer: NodeJS.Timeout | undefined;
      const read = await Promise.race([
        this.reader.read(),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), left);
        }),
      ]);
      clearTimeout(timer);
      if (read === undefined || read.done) throw new Error("no event received");
      this.buffer += this.decoder.decode(read.value, { stream: true });
    }
  }

  close(): Promise<void> {
    return this.reader.cancel();
  }
}

describe.skipIf(!live)("mandate hold (live sandbox)", { timeout: 300_000 }, () => {
  const paypal = live ? sandbox() : (undefined as never);
  const app = createApp({
    db: testDb,
    kv: testKv,
    log: pino({ level: "silent" }),
    appOrigin: APP_ORIGIN,
    authenticate: headerPrincipal,
    paypal,
    requestTimeoutMs: 60_000,
  });
  const { signed, hold, authorize, revoke, approve, release } = holdHarness(app, paypal);

  test("a signed mandate is held, approved by the buyer and authorized to ACTIVE", async () => {
    const { sub, mid, mandateHash } = await signed();
    const sse = new Sse(
      await app.request(
        `/v1/events?channel=${principalChannel({ kind: "user", subject: sub }, `mandate:${mid}`)}`,
        { headers: asUser(sub) },
      ),
    );
    let authorizationId: string | undefined;
    try {
      const held = await hold(sub, mid);
      expect(held.status, JSON.stringify(held.body)).toBe(200);
      expect(held.body.state).toBe("HOLD_PENDING");
      const orderId = held.body.orderId as string;
      console.info(`order id: ${orderId}`);

      const order = await call(paypal.paypal.orders.getOrder({ id: orderId }));
      expect(order.intent).toBe("AUTHORIZE");
      const unit = order.purchaseUnits?.[0];
      expect(unit?.amount).toMatchObject({
        currencyCode: "USD",
        value: toPayPalValue({ currency: "USD", minor: BUDGET }),
      });
      expect(unit?.customId).toBe(holdCustomId("s", mid, mandateHash));
      expect(unit?.referenceId).toBe(mid);
      expect(unit?.description).toBe(`Agent purchases under Keelson mandate ${mid}`);
      expect(await sse.data()).toMatchObject({
        type: "mandate.hold",
        state: "HOLD_PENDING",
        orderId,
      });

      await approve(orderId, mid);
      const done = await authorize(sub, mid, orderId);
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      expect(done.body.state).toBe("ACTIVE");
      authorizationId = done.body.authorizationId as string;
      console.info(`authorization id: ${authorizationId}`);

      const auth = await call(paypal.paypal.payments.getAuthorizedPayment({ authorizationId }));
      expect(auth.status).toBe("CREATED");
      expect(done.body.expiresAt).toBe(
        new Date(Date.parse(auth.createTime as string) + 29 * 86_400_000).toISOString(),
      );
      console.info(`paypal expiration_time: ${auth.expirationTime}`);
      const stored = await row(mid);
      expect(stored).toMatchObject({
        state: "ACTIVE",
        paypalOrderId: orderId,
        paypalAuthorizationId: authorizationId,
        paypalParentAuthorizationId: authorizationId,
      });
      expect(stored?.authorizedAt?.toISOString()).toBe(
        new Date(auth.createTime as string).toISOString(),
      );
      expect(await sse.data()).toMatchObject({
        type: "mandate.hold",
        state: "ACTIVE",
        orderId,
        authorizationId,
      });

      const read = await app.request(`/v1/mandates/${mid}`, { headers: asUser(sub) });
      expect(((await read.json()) as { hold: unknown }).hold).toEqual({
        mode: "mandate",
        orderId,
        authorizationId,
        authorizedAt: stored?.authorizedAt?.toISOString(),
        reauthorizedAt: null,
        remainingMinor: String(BUDGET),
        state: "AUTHORIZED",
      });

      const again = await authorize(sub, mid, orderId);
      expect(again).toEqual(done);
      expect((await hold(sub, mid)).status).toBe(409);
    } finally {
      await sse.close();
      await release(authorizationId);
    }
  });

  test("a mandate whose merchant Keelson cannot capture for gets no order", async () => {
    const { sub, mid } = await signed((m) => {
      const merchants = m.checkout.constraints.find((c) => c.type === "checkout.allowed_merchants");
      if (merchants?.type !== "checkout.allowed_merchants") throw new Error("no merchants");
      merchants.allowed = [
        {
          id: "mrc_elsewhere",
          name: "Elsewhere",
          website: "https://elsewhere.example",
          paypal_merchant_id: STORE,
        },
      ];
    });
    const res = await hold(sub, mid);
    expect(res.status).toBe(422);
    expect(res.body.type).toMatch(/merchant-not-capturable$/);
    expect(await row(mid)).toMatchObject({ state: "SIGNED", paypalOrderId: null });
  });

  test("the browser cannot substitute another order at authorization", async () => {
    const { sub, mid } = await signed();
    const held = await hold(sub, mid);
    expect(held.status).toBe(200);
    const other = holdOrderRequest({
      env: "s",
      mid,
      mandateHash: randomBytes(32),
      amount: { currency: "USD", minor: BUDGET },
      returnUrl: RETURN_URL,
      cancelUrl: CANCEL_URL,
    });
    const created = await call(paypal.paypal.orders.createOrder(other));
    const res = await authorize(sub, mid, created.id as string);
    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/order-mismatch$/);
    expect(await row(mid)).toMatchObject({
      state: "HOLD_PENDING",
      paypalOrderId: held.body.orderId,
    });
  });

  test("concurrent and repeated holds share one order", async () => {
    const { sub, mid } = await signed();
    const results = await Promise.all(Array.from({ length: 5 }, () => hold(sub, mid)));
    for (const r of results) expect(r.status, JSON.stringify(r.body)).toBe(200);
    const orderIds = new Set(results.map((r) => r.body.orderId));
    expect(orderIds.size).toBe(1);
    const [orderId] = [...orderIds] as string[];
    const published = await testDb.select().from(events).where(eq(events.subjectId, mid));
    expect(published.map((e) => (e.payload as { state: string }).state)).toEqual(["HOLD_PENDING"]);

    await approve(orderId as string, mid);
    const again = await hold(sub, mid);
    expect(again).toEqual({ status: 200, body: { orderId, state: "HOLD_PENDING" } });
  });

  test("another user's mandate does not exist for them", async () => {
    const { mid } = await signed();
    const stranger = `kls_usr_${randomBytes(8).toString("hex")}`;
    expect((await hold(stranger, mid)).status).toBe(404);
    expect((await authorize(stranger, mid, "5O190127TN364715T")).status).toBe(404);
    const read = await app.request(`/v1/mandates/${mid}`, { headers: asUser(stranger) });
    expect(read.status).toBe(404);
    expect((await row(mid))?.state).toBe("SIGNED");
  });

  test.skipIf(process.env.KEELSON_BUDGETS !== "1")(
    "latency: create, authorize and revoke over 10 holds",
    { timeout: 900_000 },
    async () => {
      const create: number[] = [];
      const authorizeMs: number[] = [];
      const voids: number[] = [];
      for (let i = 0; i < 10; i++) {
        const { sub, mid } = await signed();
        let t = performance.now();
        const held = await hold(sub, mid);
        create.push(performance.now() - t);
        expect(held.status).toBe(200);
        const orderId = held.body.orderId as string;
        await approve(orderId, mid);
        t = performance.now();
        const done = await authorize(sub, mid, orderId);
        authorizeMs.push(performance.now() - t);
        expect(done.status).toBe(200);
        const authorizationId = done.body.authorizationId as string;
        t = performance.now();
        const revoked = await revoke(sub, mid);
        voids.push(performance.now() - t);
        expect(revoked).toEqual({ status: 200, body: { state: "REVOKED" } });
        console.info(`run ${i}: order ${orderId} authorization ${authorizationId}`);
      }
      const fmt = (xs: number[]) =>
        `p50 ${Math.round(percentile(xs, 50))} ms, p95 ${Math.round(percentile(xs, 95))} ms`;
      console.info(`POST /hold: ${fmt(create)}`);
      console.info(`POST /hold/authorize: ${fmt(authorizeMs)}`);
      console.info(`POST /revoke (void of the parent): ${fmt(voids)}`);
    },
  );
});
