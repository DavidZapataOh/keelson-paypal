import { randomBytes } from "node:crypto";
import {
  type AmountCheck,
  amountConfirmChallenge,
  checkoutTotal,
  orderIdHash,
  toPayPalAmount,
} from "@keelson/core";
import { eq, evidenceBundles, evidenceItems, mandates, purchases, sql } from "@keelson/db";
import { buildSdPayload, parseMandate, RP_ID } from "@keelson/mandate";
import { pino } from "pino";
import { ulid } from "ulid";
import { beforeAll, describe, expect, test } from "vitest";
import demo from "../../../packages/mandate/test/fixtures/demo-mandate.json" with { type: "json" };
import { createApp } from "../src/app.ts";
import { channel3Mandate } from "./channel3.ts";
import { APP_ORIGIN, STORE as SANDBOX_MERCHANT, sandbox } from "./hold-live.ts";
import { testDb, testKv } from "./setup.ts";
import { asUser, headerPrincipal, SoftwarePasskey, seedPasskey } from "./tee-live.ts";

const paypalLive = Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
const paypal = paypalLive ? sandbox() : undefined;
const app = createApp({
  db: testDb,
  kv: testKv,
  log: pino({ level: "silent" }),
  authenticate: headerPrincipal,
  appOrigin: APP_ORIGIN,
  ...(paypal ? { paypal } : {}),
});
const agent = "amount-agent";
const asAgent = {
  "x-test-principal": JSON.stringify({
    kind: "client",
    subject: agent,
    scopes: ["countersign:write"],
  }),
};
const STORE_ORIGIN = "https://www.alfred.com";
/** A PayPal order id no Keelson app created: PayPal answers 404 to Keelson's credentials. */
const FOREIGN_ORDER = "5O190127TN364715T";

let mandateId: string;
let userId: string;
let passkey: SoftwarePasskey;

beforeAll(async () => {
  mandateId = await channel3Mandate("ACTIVE", agent);
  const [m] = await testDb.select().from(mandates).where(eq(mandates.id, mandateId));
  userId = (m as { userId: string }).userId;
  passkey = await SoftwarePasskey.create();
  await seedPasskey(testDb, passkey, userId);
  const mandate = parseMandate({
    ...demo,
    user: {
      ...demo.user,
      sub: userId,
      cred: { id: passkey.credentialId, rp_id: RP_ID, jwk: passkey.jwk },
    },
    payment: {
      ...demo.payment,
      constraints: demo.payment.constraints.map((c) =>
        c.type === "payment.allowed_payees"
          ? { ...c, allowed: [{ paypal_merchant_id: SANDBOX_MERCHANT }] }
          : c,
      ),
    },
  });
  const sd = await buildSdPayload(mandate, () => randomBytes(16));
  await testDb
    .update(mandates)
    .set({ payloadSd: sd.payloadSd, disclosures: sd.disclosures })
    .where(eq(mandates.id, mandateId));
});

/** A live purchase Keelson allowed for `total`, its evidence binding the countersigned amount. */
async function livePurchase(total = checkoutTotal("USD", { items: 1000, tax: 84, shipping: 150 })) {
  const root = randomBytes(32);
  await testDb.insert(evidenceBundles).values({ root, mandateId, manifest: {}, uploadedBy: agent });
  await testDb.insert(evidenceItems).values({
    root,
    index: 0,
    type: "api.checkout",
    mediaType: "application/json",
    contentHash: randomBytes(32),
    salt: randomBytes(32),
    bytes: Buffer.from(JSON.stringify(toPayPalAmount(total))),
  });
  const id = ulid();
  await testDb.insert(purchases).values({
    id,
    mandateId,
    clientId: agent,
    state: "LOGGED",
    decision: 1,
    liveStore: STORE_ORIGIN,
    merchantId: "mrc_alfred",
    currency: total.currency,
    amountMinor: BigInt(total.minor),
    cartHash: randomBytes(32),
    evidenceRoot: root,
  });
  return id;
}

const check = (id: string, body: Record<string, unknown>, headers = asAgent) =>
  app.request(`/v1/purchases/${id}/amount-check`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": ulid(), ...headers },
    body: JSON.stringify(body),
  });

describe("amount check", () => {
  test("PayPal's checkout disagreeing with Keelson always holds", async () => {
    const id = await livePurchase();
    const res = await check(id, { orderId: FOREIGN_ORDER, crossCheck: "disagrees" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ field: "order" });
  });

  test("only the client that asked for the countersign checks a live purchase", async () => {
    const id = await livePurchase();
    const other = {
      "x-test-principal": JSON.stringify({
        kind: "client",
        subject: "x",
        scopes: ["countersign:write"],
      }),
    };
    expect((await check(id, { orderId: FOREIGN_ORDER, crossCheck: "agrees" }, other)).status).toBe(
      404,
    );
  });

  test("an order Keelson cannot read is confirmed by the user's passkey", async () => {
    const id = await livePurchase();
    const body = {
      orderId: FOREIGN_ORDER,
      crossCheck: "agrees",
      order: { intent: "SALE", payee: SANDBOX_MERCHANT },
    };
    const asked = await check(id, body);
    expect(asked.status).toBe(202);
    expect(await asked.json()).toMatchObject({ needs: "user_confirmed" });
    expect((await check(id, body)).status).toBe(202);

    const shown = await app.request(`/v1/purchases/${id}/amount-confirmation`, {
      headers: asUser(userId),
    });
    expect(shown.status).toBe(200);
    const confirmation = (await shown.json()) as { challenge: string; state: string };
    const challenge = amountConfirmChallenge({
      purchase_id: id,
      order_id_hash: orderIdHash(FOREIGN_ORDER),
      currency: "USD",
      minor: 1234,
      payee: SANDBOX_MERCHANT,
    });
    expect(confirmation).toMatchObject({
      store: STORE_ORIGIN,
      payee: SANDBOX_MERCHANT,
      total: { currency: "USD", minor: "1234" },
      state: "PENDING",
      challenge: Buffer.from(challenge).toString("base64url"),
      credentialId: passkey.credentialId,
    });
    expect(
      (await app.request(`/v1/purchases/${id}/amount-confirmation`, { headers: asUser("someone") }))
        .status,
    ).toBe(404);

    const answer = (assertion: object) =>
      app.request(`/v1/purchases/${id}/amount-confirmation`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": ulid(),
          ...asUser(userId),
        },
        body: JSON.stringify({ assertion: { ...assertion, credentialId: passkey.credentialId } }),
      });
    // An assertion over another amount does not verify.
    const wrong = await passkey.assert(
      amountConfirmChallenge({
        purchase_id: id,
        order_id_hash: orderIdHash(FOREIGN_ORDER),
        currency: "USD",
        minor: 1235,
        payee: SANDBOX_MERCHANT,
      }),
    );
    expect((await answer(wrong)).status).toBe(401);

    const res = await answer(await passkey.assert(challenge));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "CONFIRMED" });
    const decided = await check(id, body);
    expect(decided.status).toBe(200);
    expect(await decided.json()).toMatchObject({
      authority: "user_confirmed",
      read_by: "api",
      total: { currency: "USD", minor: 1234 },
      payee: SANDBOX_MERCHANT,
      cross_check: "agrees",
      evidence: { assertion: { credentialId: passkey.credentialId } },
    });
    expect((await answer(await passkey.assert(challenge))).status).toBe(409);
  });

  test("a declined or expired confirmation never pays", async () => {
    const body = { orderId: FOREIGN_ORDER, crossCheck: "unavailable" };
    const declined = await livePurchase();
    expect((await check(declined, body)).status).toBe(202);
    const no = await app.request(`/v1/purchases/${declined}/amount-confirmation`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": ulid(), ...asUser(userId) },
      body: JSON.stringify({ decline: true }),
    });
    expect(no.status).toBe(200);
    const after = await check(declined, body);
    expect(after.status).toBe(409);
    expect(((await after.json()) as { type: string }).type).toMatch(/amount-declined$/);

    const late = await livePurchase();
    expect((await check(late, body)).status).toBe(202);
    await testDb
      .update(purchases)
      .set({
        amountConfirm: sql`jsonb_set(${purchases.amountConfirm}, '{expires_at}', to_jsonb(${new Date(Date.now() - 1000).toISOString()}::text))`,
      })
      .where(eq(purchases.id, late));
    expect((await check(late, body)).status).toBe(410);
    const answer = await app.request(`/v1/purchases/${late}/amount-confirmation`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": ulid(), ...asUser(userId) },
      body: JSON.stringify({ decline: true }),
    });
    expect(answer.status).toBe(410);
  });

  describe.runIf(paypalLive)("PayPal's Orders API (sandbox)", { timeout: 60_000 }, () => {
    /** A real sandbox order Keelson's PayPal app creates, as the demo store does. */
    async function order(amount: object): Promise<string> {
      const created = await (paypal as NonNullable<typeof paypal>).paypal.fetch<{ id: string }>(
        "POST",
        "/v2/checkout/orders",
        { body: { intent: "CAPTURE", purchase_units: [{ amount }] } },
      );
      return created.id;
    }
    const amount = toPayPalAmount(checkoutTotal("USD", { items: 1000, tax: 84, shipping: 150 }));

    test("an order Keelson's app created decides the amount, once", async () => {
      const id = await livePurchase();
      const orderId = await order(amount);
      const res = await check(id, {
        orderId,
        crossCheck: "unavailable",
        order: { intent: "SALE", payee: SANDBOX_MERCHANT },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as AmountCheck;
      expect(body).toMatchObject({
        v: "keelson.amount_check/1",
        authority: "paypal_order",
        via: "own",
        read_by: "api",
        order_id_hash: orderIdHash(orderId),
        total: { currency: "USD", minor: 1234 },
        payee: SANDBOX_MERCHANT,
        intent: "CAPTURE",
        cross_check: "unavailable",
      });
      const [row] = await testDb.select().from(purchases).where(eq(purchases.id, id));
      expect(row?.amountCheck).toEqual(body);
      expect((await check(id, { orderId, crossCheck: "agrees" })).status).toBe(200);
      const other = await check(id, { orderId: await order(amount), crossCheck: "agrees" });
      expect(other.status).toBe(409);
      expect(((await other.json()) as { type: string }).type).toMatch(/amount-order-changed$/);
    });

    test("an order one cent off, or split otherwise, holds", async () => {
      const less = await livePurchase(checkoutTotal("USD", { items: 999, tax: 84, shipping: 150 }));
      const res = await check(less, { orderId: await order(amount), crossCheck: "agrees" });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ field: "total" });
      const split = await livePurchase(checkoutTotal("USD", { items: 1084, shipping: 150 }));
      const again = await check(split, { orderId: await order(amount), crossCheck: "agrees" });
      expect(await again.json()).toMatchObject({ field: "breakdown" });
    });

    test("an order paying a merchant the mandate does not name holds", async () => {
      const [m] = await testDb.select().from(mandates).where(eq(mandates.id, mandateId));
      const original = { payloadSd: m?.payloadSd, disclosures: m?.disclosures };
      const other = parseMandate({
        ...demo,
        payment: {
          ...demo.payment,
          constraints: demo.payment.constraints.map((c) =>
            c.type === "payment.allowed_payees"
              ? { ...c, allowed: [{ paypal_merchant_id: "DZ93UDZC2BKLE" }] }
              : c,
          ),
        },
      });
      const sd = await buildSdPayload(other, () => randomBytes(16));
      await testDb
        .update(mandates)
        .set({ payloadSd: sd.payloadSd, disclosures: sd.disclosures })
        .where(eq(mandates.id, mandateId));
      try {
        const id = await livePurchase();
        const res = await check(id, { orderId: await order(amount), crossCheck: "agrees" });
        expect(await res.json()).toMatchObject({ field: "payee" });
      } finally {
        await testDb
          .update(mandates)
          .set(original as { payloadSd: Record<string, unknown>; disclosures: string[] })
          .where(eq(mandates.id, mandateId));
      }
    });
  });
});
