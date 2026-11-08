import { cartHash, toPayPalValue } from "@keelson/core";
import { eq, events, purchaseHolds } from "@keelson/db";
import { closeMandate } from "@keelson/mandate";
import { purchaseHoldCustomId, purchaseHoldDigest } from "@keelson/paypal";
import { pino } from "pino";
import { ulid } from "ulid";
import { bytesToHex } from "viem";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { purchaseHoldOf } from "../src/hold/state.ts";
import { call } from "../src/paypal.ts";
import { createTee } from "../src/tee/config.ts";
import { refreshLeg } from "../src/tee/signers.ts";
import { EvidenceUploader } from "./evidence.ts";
import { APP_ORIGIN, holdHarness, row, sandbox } from "./hold-live.ts";
import { testDb, testKv } from "./setup.ts";
import { asAgent, asUser, carts, headerPrincipal, live, liveEnv } from "./tee-live.ts";

const cart = carts.demo;
const CART_HASH = bytesToHex(cartHash(cart.cart));
const TOTAL = cart.cart.lines.reduce((s, l) => s + BigInt(l.qty) * BigInt(l.unit_minor), 0n);
/** A second merchant the mandate allows; Keelson cannot capture for it. */
const TRAILHUB = {
  id: "mrc_trailhub",
  name: "TrailHub",
  website: "https://trailhub.example",
  paypal_merchant_id: "TRAILHUB7Q2LD",
};

const percentile = (xs: number[], p: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;
};

describe.skipIf(!live)("per-purchase holds (live sandbox and legs)", { timeout: 600_000 }, () => {
  const paypal = live ? sandbox() : (undefined as never);
  const tee = live ? createTee(liveEnv(), { a: 10_000, b: 10_000 }) : (undefined as never);
  const app = createApp({
    db: testDb,
    kv: testKv,
    log: pino({ level: "silent" }),
    appOrigin: APP_ORIGIN,
    authenticate: headerPrincipal,
    paypal,
    tee,
    requestTimeoutMs: 60_000,
  });
  const { post, signed, approve, release } = holdHarness(app, paypal);
  const evidence = new EvidenceUploader();
  const authorized: string[] = [];

  type Mandate = Awaited<ReturnType<typeof signed>>;
  const multi = () =>
    signed((m) => {
      const allowed = m.checkout.constraints.find((c) => c.type === "checkout.allowed_merchants");
      if (allowed?.type === "checkout.allowed_merchants") allowed.allowed.push(TRAILHUB);
    });

  const send = async (path: string, body: unknown, headers: Record<string, string>) => {
    const res = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": ulid(), ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  const close = (
    m: Pick<Mandate, "openMandate" | "agentKey">,
    requestId: string,
    hash = CART_HASH,
  ) => closeMandate(m.openMandate, { requestId, cartHash: `sha256:${hash.slice(2)}` }, m.agentKey);

  /** The agent asks a hold for the demo cart under `requestId`. */
  const askHold = async (
    m: Mandate,
    requestId = ulid(),
    o: { amountMinor?: bigint; merchant?: string; key?: CryptoKey } = {},
  ) =>
    send(
      `/v1/mandates/${m.mid}/holds`,
      {
        requestId,
        merchant: o.merchant ?? cart.cart.merchant,
        currency: cart.cart.currency,
        amountMinor: (o.amountMinor ?? TOTAL).toString(),
        cartHash: CART_HASH,
        closedMandate: await close({ ...m, agentKey: o.key ?? m.agentKey }, requestId),
      },
      asAgent,
    );

  /** Holds, approves and authorizes one demo cart; resolves to its request and authorization ids. */
  const heldCart = async (m: Mandate) => {
    const requestId = ulid();
    const held = await askHold(m, requestId);
    expect(held.status, JSON.stringify(held.body)).toBe(201);
    const orderId = held.body.orderId as string;
    await approve(orderId, m.mid);
    const done = await send(
      `/v1/mandates/${m.mid}/holds/${requestId}/authorize`,
      { orderId },
      asUser(m.sub),
    );
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const authorizationId = done.body.authorizationId as string;
    authorized.push(authorizationId);
    return { requestId, orderId, authorizationId };
  };

  const countersign = async (m: Mandate, requestId: string, authorizationId: string) =>
    send(
      "/v1/countersign",
      {
        authorizationId,
        closedMandate: await close(m, requestId),
        cart: cart.cart,
        unit: cart.unit,
        evidenceRoot: await evidence.upload(app, m.mid, cart.cart, asAgent),
      },
      asAgent,
    );

  let mandate: Mandate;
  let first: Awaited<ReturnType<typeof heldCart>>;

  beforeAll(async () => {
    await refreshLeg(testDb, "a", tee);
    await refreshLeg(testDb, "b", tee);
    mandate = await multi();
  }, 120_000);

  afterAll(async () => {
    console.info(`voiding purchase hold authorizations: ${authorized.join(", ")}`);
    for (const id of authorized) await release(id);
    await evidence.close();
  });

  test("a mandate allowing two merchants holds per purchase and is ACTIVE once signed", async () => {
    const stored = await row(mandate.mid);
    expect(stored?.holdMode).toBe("per_purchase");
    expect(stored?.state).toBe("ACTIVE");
    expect(stored?.paypalOrderId).toBeNull();
    const held = await post(`/v1/mandates/${mandate.mid}/hold`, mandate.sub);
    expect(held.status).toBe(409);
    expect(((await held.json()) as { type: string }).type).toMatch(/per-purchase-mandate$/);
  });

  test("the agent holds one cart, the buyer approves it and the user authorizes it", async () => {
    const requestId = ulid();
    const held = await askHold(mandate, requestId);
    expect(held.status, JSON.stringify(held.body)).toBe(201);
    const orderId = held.body.orderId as string;
    expect(held.body.requestId).toBe(requestId);
    console.info(`purchase hold order ${orderId} for request ${requestId}`);

    const order = await call(paypal.paypal.orders.getOrder({ id: orderId }));
    const unit = order.purchaseUnits?.[0];
    const digest = purchaseHoldDigest({
      mandateHash: mandate.mandateHash,
      cartHash: Buffer.from(CART_HASH.slice(2), "hex"),
      merchantId: cart.cart.merchant,
      amount: { currency: "USD", minor: TOTAL },
    });
    expect(order.intent).toBe("AUTHORIZE");
    expect(unit?.customId).toBe(purchaseHoldCustomId("s", requestId, digest));
    expect(unit?.referenceId).toBe(requestId);
    expect(unit?.amount?.value).toBe(toPayPalValue({ currency: "USD", minor: TOTAL }));

    // A retry of the same request answers the same order.
    const again = await askHold(mandate, requestId);
    expect(again.status).toBe(201);
    expect(again.body.orderId).toBe(orderId);

    const published = await testDb.select().from(events).where(eq(events.subjectId, mandate.mid));
    expect(published.map((e) => (e.payload as { type: string }).type)).toContain(
      "mandate.purchase_hold",
    );

    const wrong = await send(
      `/v1/mandates/${mandate.mid}/holds/${requestId}/authorize`,
      { orderId: "0ABCDEFGHIJKLMNOP" },
      asUser(mandate.sub),
    );
    expect(wrong.status).toBe(409);
    expect(wrong.body.type).toMatch(/order-mismatch$/);
    const stranger = await send(
      `/v1/mandates/${mandate.mid}/holds/${requestId}/authorize`,
      { orderId },
      asUser("kls_usr_someoneelse"),
    );
    expect(stranger.status).toBe(404);

    await approve(orderId, mandate.mid);
    const done = await send(
      `/v1/mandates/${mandate.mid}/holds/${requestId}/authorize`,
      { orderId },
      asUser(mandate.sub),
    );
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const authorizationId = done.body.authorizationId as string;
    authorized.push(authorizationId);
    expect(done.body.state).toBe("AUTHORIZED");
    expect(await purchaseHoldOf(testDb, requestId)).toEqual({
      mandateId: mandate.mid,
      orderId,
      authorizationId,
      amountMinor: TOTAL,
      merchantId: cart.cart.merchant,
      state: "AUTHORIZED",
    });
    const retried = await send(
      `/v1/mandates/${mandate.mid}/holds/${requestId}/authorize`,
      { orderId },
      asUser(mandate.sub),
    );
    expect(retried.body.authorizationId).toBe(authorizationId);
    first = { requestId, orderId, authorizationId };
  });

  test("an agent that does not hold the mandate's key is refused", async () => {
    const other = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const res = await askHold(mandate, ulid(), { key: other.privateKey });
    expect(res.status).toBe(403);
    expect(res.body.type).toMatch(/not-mandate-agent$/);
  });

  test("a cart above the mandate's budget or for a merchant Keelson cannot capture is refused", async () => {
    const over = await askHold(mandate, ulid(), { amountMinor: 10_001n });
    expect(over.status).toBe(422);
    expect(over.body.type).toMatch(/amount-exceeds-mandate$/);
    const elsewhere = await askHold(mandate, ulid(), { merchant: TRAILHUB.id });
    expect(elsewhere.status).toBe(422);
    expect(elsewhere.body.type).toMatch(/merchant-not-capturable$/);
  });

  test("a mandate with one merchant holds its budget and refuses cart holds", async () => {
    const single = await signed();
    expect((await row(single.mid))?.holdMode).toBe("mandate");
    const res = await askHold(single);
    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/mandate-hold-mandate$/);
  });

  test("countersign refuses a cart hold that is not this mandate's for this request", async () => {
    const anotherRequest = await countersign(mandate, ulid(), first.authorizationId);
    expect(anotherRequest.status, JSON.stringify(anotherRequest.body)).toBe(422);
    expect(anotherRequest.body.type).toMatch(/authorization-not-held$/);

    const single = await signed();
    const anotherMandate = await countersign(single, first.requestId, first.authorizationId);
    expect(anotherMandate.status, JSON.stringify(anotherMandate.body)).toBe(422);
    expect(anotherMandate.body.type).toMatch(/authorization-not-held$/);

    const outside = await countersign(
      mandate,
      ulid(),
      process.env.PAYPAL_AUTHORIZATION_CREATED as string,
    );
    expect(outside.status, JSON.stringify(outside.body)).toBe(422);
    expect(outside.body.type).toMatch(/authorization-not-held$/);
  });

  test("both legs countersign each cart on its own hold", async () => {
    const res = await countersign(mandate, first.requestId, first.authorizationId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.decision, JSON.stringify(res.body.trace)).toBe("allow");
    expect(res.body.mode).toBe("2of2");

    const second = await heldCart(mandate);
    const again = await countersign(mandate, second.requestId, second.authorizationId);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.decision, JSON.stringify(again.body.trace)).toBe("allow");
    expect(JSON.stringify(again.body.trace)).not.toContain("hold_mismatch");
  });

  test("creating a cart hold is measured", async () => {
    const ms: number[] = [];
    for (let i = 0; i < 10; i++) {
      const started = performance.now();
      const res = await askHold(mandate);
      ms.push(performance.now() - started);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    const pending = await testDb
      .select()
      .from(purchaseHolds)
      .where(eq(purchaseHolds.mandateId, mandate.mid));
    expect(pending.filter((h) => h.state === "PENDING").length).toBeGreaterThanOrEqual(10);
    console.info(
      `purchase hold create: p50 ${percentile(ms, 50).toFixed(0)} ms, p95 ${percentile(ms, 95).toFixed(0)} ms`,
    );
  });
});
