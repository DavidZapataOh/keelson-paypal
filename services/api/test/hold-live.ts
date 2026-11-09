import { randomBytes } from "node:crypto";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { eq, mandates } from "@keelson/db";
import { ids, type PayPal, PayPalError } from "@keelson/paypal";
import { approveOrder, payerActionUrl } from "@keelson/paypal/testing";
import { ulid } from "ulid";
import { expect } from "vitest";
import { call, createPayPalDeps, type PayPalDeps } from "../src/paypal.ts";
import { testDb } from "./setup.ts";
import { asUser, SoftwarePasskey, seedUser, signedMandate } from "./tee-live.ts";

export const APP_ORIGIN = "https://app.keelson.finance";
/** The demo store: the account whose credentials create and capture holds. */
export const STORE = "A4WCRYD5EYDF2";

/** The sandbox client of the demo store. */
export const sandbox = (): PayPalDeps =>
  createPayPalDeps({
    PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID as string,
    PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET as string,
    PAYPAL_ENV: "sandbox",
    PAYPAL_MERCHANT_ID: STORE,
  });

/** The real sandbox client, running `after` once PayPal answered each Authorize Order call. */
export function afterAuthorize(paypal: PayPalDeps, after: () => Promise<void>): PayPalDeps {
  const orders = new Proxy(paypal.paypal.orders, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== "authorizeOrder" || typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const res = await value.apply(target, args);
        await after();
        return res;
      };
    },
  });
  return { ...paypal, paypal: { ...paypal.paypal, orders } as PayPal };
}

export const row = async (mid: string) =>
  (await testDb.select().from(mandates).where(eq(mandates.id, mid)))[0];

export interface Answer {
  status: number;
  body: Record<string, unknown>;
}

/** Signs, holds and authorizes mandates through `app`, with the sandbox buyer approving. */
export function holdHarness(app: Pick<OpenAPIHono, "request">, paypal: PayPalDeps) {
  const post = (path: string, sub: string, body?: unknown, key = ulid()) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key, ...asUser(sub) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const answer = async (res: Response): Promise<Answer> => ({
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  });

  /** A new user with a passkey and the mandate they signed (after `edit`), stored as SIGNED. */
  const signed = async (edit?: Parameters<typeof signedMandate>[3]) => {
    const passkey = await SoftwarePasskey.create();
    const sub = `kls_usr_${randomBytes(8).toString("hex")}`;
    await seedUser(testDb, passkey, sub);
    const mandate = await signedMandate(passkey, sub, undefined, (m) => {
      m.mid = ulid();
      edit?.(m);
    });
    const res = await post("/v1/mandates", sub, mandate.body);
    const body = (await res.json()) as { id: string; mandateHash: string; openMandate: string };
    expect(res.status, JSON.stringify(body)).toBe(201);
    return {
      sub,
      mid: body.id,
      mandateHash: Buffer.from(body.mandateHash.slice(2), "hex"),
      openMandate: body.openMandate,
      agentKey: mandate.key,
    };
  };

  const hold = async (sub: string, mid: string, key?: string) =>
    answer(await post(`/v1/mandates/${mid}/hold`, sub, undefined, key));
  const authorize = async (sub: string, mid: string, orderId: string) =>
    answer(await post(`/v1/mandates/${mid}/hold/authorize`, sub, { orderId }));
  const revoke = async (sub: string, mid: string) =>
    answer(await post(`/v1/mandates/${mid}/revoke`, sub));

  /** The buyer approves the order on PayPal; it returns to the mandate's page. */
  const approve = async (orderId: string, mid: string) => {
    const order = await call(paypal.paypal.orders.getOrder({ id: orderId }));
    await approveOrder(payerActionUrl(order), `${APP_ORIGIN}/mandates/${mid}`);
  };

  /** Holds, approves and authorizes `mid`; resolves to its authorization id. */
  const activate = async (sub: string, mid: string) => {
    const held = await hold(sub, mid);
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    const orderId = held.body.orderId as string;
    await approve(orderId, mid);
    const done = await authorize(sub, mid, orderId);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    return { orderId, authorizationId: done.body.authorizationId as string };
  };

  /** Voids an authorization left open; one already voided or captured is fine. */
  const release = async (authorizationId: string | null | undefined) => {
    if (!authorizationId) return;
    await call(
      paypal.paypal.payments.voidPayment({
        authorizationId,
        paypalRequestId: ids.operationRequestId(authorizationId, "void"),
      }),
    ).catch((e: unknown) => {
      if (!(e instanceof PayPalError)) throw e;
      console.info(`void ${authorizationId}: ${e.details[0]?.issue ?? e.name}`);
    });
  };

  return { post, signed, hold, authorize, revoke, approve, activate, release };
}
