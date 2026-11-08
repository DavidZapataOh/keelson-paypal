import { randomBytes, randomUUID } from "node:crypto";
import { cartHash, fromPayPalValue } from "@keelson/core";
import { eq, mandates, transition } from "@keelson/db";
import { closeMandate } from "@keelson/mandate";
import { ids, type PayPal } from "@keelson/paypal";
import { pino } from "pino";
import { ulid } from "ulid";
import { bytesToHex } from "viem";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { type HoldDeps, maintainHolds, reconcileHold, voidHold } from "../src/hold/maintenance.ts";
import { call, type PayPalDeps } from "../src/paypal.ts";
import { createTee } from "../src/tee/config.ts";
import { refreshLeg } from "../src/tee/signers.ts";
import { EvidenceUploader } from "./evidence.ts";
import { APP_ORIGIN, holdHarness, row, sandbox } from "./hold-live.ts";
import { testDb, testKv } from "./setup.ts";
import {
  asAgent,
  carts,
  headerPrincipal,
  live,
  liveEnv,
  SoftwarePasskey,
  seedUser,
} from "./tee-live.ts";

const DAY_MS = 86_400_000;
const MIN_AGE_DAYS = 4;

/** The real sandbox client, with every payments call it makes recorded as `<method>:<authorization id>`. */
function recorded(paypal: PayPalDeps, calls: string[]): PayPalDeps {
  const payments = new Proxy(paypal.paypal.payments, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(`${String(prop)}:${(args[0] as { authorizationId?: string }).authorizationId}`);
        return value.apply(target, args);
      };
    },
  });
  return { ...paypal, paypal: { ...paypal.paypal, payments } as PayPal };
}

const status = async (paypal: PayPalDeps, authorizationId: string) =>
  (await call(paypal.paypal.payments.getAuthorizedPayment({ authorizationId }))).status;

/** An aged sandbox authorization named by `name`, and how many days old it is. */
async function aged(name: string) {
  const authorizationId = process.env[name];
  if (!live || !authorizationId) {
    return { name, auth: undefined, days: 0, skip: `skipped: ${name} is not set` };
  }
  const auth = await call(sandbox().paypal.payments.getAuthorizedPayment({ authorizationId }));
  const days = Math.floor((Date.now() - Date.parse(auth.createTime as string)) / DAY_MS);
  return {
    name,
    auth,
    days,
    ...(days < MIN_AGE_DAYS ? { skip: `skipped: ${name} is ${days} days old` } : {}),
  };
}
const agedCases = await Promise.all(
  ["PAYPAL_AGED_AUTHORIZATION_ID", "PAYPAL_AGED_PARTIAL_AUTHORIZATION_ID"].map(aged),
);

describe.skipIf(!live)("hold maintenance (live sandbox)", { timeout: 600_000 }, () => {
  const calls: string[] = [];
  const paypal = live ? recorded(sandbox(), calls) : (undefined as never);
  const log = pino({ level: "silent" });
  const deps: HoldDeps = { db: testDb, kv: testKv, log, paypal };
  const base = {
    db: testDb,
    kv: testKv,
    log,
    appOrigin: APP_ORIGIN,
    authenticate: headerPrincipal,
    paypal,
    requestTimeoutMs: 60_000,
  };
  const app = createApp(base);
  const h = holdHarness(app, paypal);
  const tick = (now?: Date) => maintainHolds(deps, now);
  const voids = (authorizationId: string) =>
    calls.filter((c) => c === `voidPayment:${authorizationId}`).length;

  test("an expired mandate's hold is voided by the next tick", async () => {
    let exp = 0;
    const { sub, mid } = await h.signed((m) => {
      exp = Math.floor(Date.now() / 1000) + 120;
      m.exp = exp;
    });
    const { authorizationId } = await h.activate(sub, mid);
    try {
      await tick();
      expect((await row(mid))?.state).toBe("ACTIVE");
      expect(await tick(new Date(exp * 1000 + 1000))).toBe(0);
      const ended = await row(mid);
      expect(ended?.state).toBe("EXPIRED");
      expect(ended?.voidedAt).not.toBeNull();
      expect(await status(paypal, authorizationId)).toBe("VOIDED");
      expect(voids(authorizationId)).toBe(1);
    } finally {
      await h.release(authorizationId);
    }
  });

  test("revoking an active mandate voids its hold at once", async () => {
    const { sub, mid } = await h.signed();
    const { authorizationId } = await h.activate(sub, mid);
    try {
      const started = performance.now();
      const res = await h.revoke(sub, mid);
      console.info(`revoke with void: ${Math.round(performance.now() - started)} ms`);
      expect(res).toEqual({ status: 200, body: { state: "REVOKED" } });
      const ended = await row(mid);
      expect(ended?.revokeRequestedAt).not.toBeNull();
      expect(ended?.voidedAt).not.toBeNull();
      expect(await status(paypal, authorizationId)).toBe("VOIDED");
      expect(await h.revoke(sub, mid)).toEqual({ status: 200, body: { state: "REVOKED" } });
      expect(await voidHold(deps, mid, "REVOKED")).toBe("already");
      expect(voids(authorizationId)).toBe(1);
    } finally {
      await h.release(authorizationId);
    }
  });

  describe("with a purchase countersigned by the live legs", () => {
    const tee = live ? createTee(liveEnv(), { a: 10_000, b: 10_000 }) : (undefined as never);
    const teeApp = createApp({ ...base, tee });
    const t = holdHarness(teeApp, paypal);
    const evidence = new EvidenceUploader();
    beforeAll(async () => {
      await refreshLeg(testDb, "a", tee);
      await refreshLeg(testDb, "b", tee);
    }, 120_000);
    afterAll(() => evidence.close());

    const countersign = async (
      m: { mid: string; openMandate: string; agentKey: CryptoKey },
      authorizationId: string,
      requestId: string,
      evidenceRoot?: `0x${string}`,
    ) => {
      const cart = carts.demo;
      const hash = bytesToHex(cartHash(cart.cart)).slice(2);
      return teeApp.request("/v1/countersign", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": ulid(), ...asAgent },
        body: JSON.stringify({
          authorizationId,
          closedMandate: await closeMandate(
            m.openMandate,
            { requestId, cartHash: `sha256:${hash}` },
            m.agentKey,
          ),
          cart: cart.cart,
          unit: cart.unit,
          evidenceRoot: evidenceRoot ?? (await evidence.upload(teeApp, m.mid, cart.cart, asAgent)),
        }),
      });
    };

    test("revoking waits for a covered purchase, refuses new countersigns, and voids after it", async () => {
      const m = await t.signed();
      const { authorizationId } = await t.activate(m.sub, m.mid);
      try {
        const requestId = ulid();
        const signed = await countersign(m, authorizationId, requestId);
        const result = (await signed.json()) as { decision?: string };
        expect(signed.status, JSON.stringify(result)).toBe(200);
        expect(result.decision).toBe("allow");
        expect(await transition(testDb, "purchases", requestId, "COUNTERSIGNED", "LOGGED")).toBe(
          true,
        );
        expect(await transition(testDb, "purchases", requestId, "LOGGED", "COVERED")).toBe(true);

        expect(await t.revoke(m.sub, m.mid)).toEqual({ status: 202, body: { state: "REVOKING" } });
        expect(await row(m.mid)).toMatchObject({ state: "ACTIVE", voidedAt: null });
        expect(await status(paypal, authorizationId)).toBe("CREATED");
        const refused = await countersign(m, authorizationId, ulid(), `0x${"55".repeat(32)}`);
        expect(refused.status).toBe(409);
        expect(((await refused.json()) as { type: string }).type).toMatch(/mandate-not-active$/);

        await tick();
        expect((await row(m.mid))?.state).toBe("ACTIVE");
        expect(voids(authorizationId)).toBe(0);

        expect(await transition(testDb, "purchases", requestId, "COVERED", "FAILED")).toBe(true);
        await tick();
        expect((await row(m.mid))?.state).toBe("REVOKED");
        expect(await status(paypal, authorizationId)).toBe("VOIDED");
        expect(voids(authorizationId)).toBe(1);
      } finally {
        await t.release(authorizationId);
      }
    });
  });

  test("a mandate exhausted by a final capture ends without a void", async () => {
    const { sub, mid } = await h.signed();
    const { authorizationId } = await h.activate(sub, mid);
    const budget = (await row(mid))?.maxMinor as bigint;
    let captureId: string | undefined;
    try {
      const capture = await call(
        paypal.paypal.payments.captureAuthorizedPayment({
          authorizationId,
          paypalRequestId: randomUUID(),
          body: {
            amount: { currencyCode: "USD", value: (Number(budget) / 100).toFixed(2) },
            finalCapture: true,
          },
        }),
      );
      captureId = capture.id;
      await testDb.update(mandates).set({ remainingMinor: 0n }).where(eq(mandates.id, mid));
      await tick();
      expect((await row(mid))?.state).toBe("EXHAUSTED");
      expect(voids(authorizationId)).toBe(0);
      expect(await status(paypal, authorizationId)).toBe("CAPTURED");
    } finally {
      if (captureId) {
        await call(
          paypal.paypal.payments.refundCapturedPayment({
            captureId,
            paypalRequestId: randomUUID(),
          }),
        );
      } else {
        await h.release(authorizationId);
      }
    }
  });

  test("a hold voided outside Keelson ends the mandate as EXPIRED on reconcile", async () => {
    const { sub, mid } = await h.signed();
    const { authorizationId } = await h.activate(sub, mid);
    await h.release(authorizationId);
    const first = await reconcileHold(deps, mid);
    expect(first.effect).toBe("applied");
    expect((first.resource as { status: string }).status).toBe("VOIDED");
    expect(await row(mid)).toMatchObject({ state: "EXPIRED", holdError: "paypal:VOIDED" });
    expect((await reconcileHold(deps, mid)).effect).toBe("unchanged");
  });

  test("a pending hold authorized directly on PayPal becomes ACTIVE on reconcile", async () => {
    const { sub, mid } = await h.signed();
    const held = await h.hold(sub, mid);
    const orderId = held.body.orderId as string;
    await h.approve(orderId, mid);
    const authorized = await call(
      paypal.paypal.orders.authorizeOrder({
        id: orderId,
        paypalRequestId: ids.operationRequestId(orderId, "authorize"),
      }),
    );
    const authorizationId = authorized.purchaseUnits?.[0]?.payments?.authorizations?.[0]
      ?.id as string;
    try {
      expect((await reconcileHold(deps, mid)).effect).toBe("applied");
      expect(await row(mid)).toMatchObject({
        state: "ACTIVE",
        paypalAuthorizationId: authorizationId,
        paypalParentAuthorizationId: authorizationId,
      });
      expect((await reconcileHold(deps, mid)).effect).toBe("unchanged");
    } finally {
      await h.release(authorizationId);
    }
  });

  test("a revoked mandate is left as it is", async () => {
    const { sub, mid } = await h.signed();
    expect(await h.revoke(sub, mid)).toEqual({ status: 200, body: { state: "REVOKED" } });
    expect(await reconcileHold(deps, mid)).toEqual({ effect: "unchanged", resource: null });
  });

  for (const c of agedCases) {
    test.skipIf(c.skip !== undefined)(
      c.skip ?? `reauthorizes the ${c.days}-day-old ${c.name} once and voids it through the parent`,
      async () => {
        const auth = c.auth as NonNullable<typeof c.auth>;
        const parent = auth.id as string;
        const orderId = auth.supplementaryData?.relatedIds?.orderId as string;
        const order = await call(paypal.paypal.orders.getOrder({ id: orderId }));
        const captured = (order.purchaseUnits?.[0]?.payments?.captures ?? [])
          .filter((x) => x.status === "COMPLETED")
          .reduce((sum, x) => sum + fromPayPalValue("USD", x.amount?.value as string).minor, 0n);
        const max = fromPayPalValue("USD", auth.amount?.value as string).minor;

        const passkey = await SoftwarePasskey.create();
        const sub = `kls_usr_${randomBytes(8).toString("hex")}`;
        await seedUser(testDb, passkey, sub);
        const mid = ulid();
        await testDb.insert(mandates).values({
          id: mid,
          userId: sub,
          operatorAgentId: 42n,
          currency: "USD",
          maxMinor: max,
          remainingMinor: max - captured,
          merchantIds: ["mrc_runfast"],
          expiresAt: new Date(Date.now() + 7 * DAY_MS),
          mandateHash: randomBytes(32),
        });
        for (const [from, to] of [
          ["DRAFT", "COMPILED"],
          ["COMPILED", "SIGNED"],
          ["SIGNED", "HOLD_PENDING"],
          ["HOLD_PENDING", "ACTIVE"],
        ] as const) {
          expect(
            await transition(testDb, "mandates", mid, from as never, to as never, {
              paypalOrderId: orderId,
              paypalAuthorizationId: parent,
              paypalParentAuthorizationId: parent,
              authorizedAt: new Date(auth.createTime as string),
            }),
          ).toBe(true);
        }

        const started = performance.now();
        await tick();
        console.info(
          `${c.name}: tick with reauthorize ${Math.round(performance.now() - started)} ms`,
        );
        const after = await row(mid);
        expect(after?.reauthorizedAt).not.toBeNull();
        expect(after?.paypalParentAuthorizationId).toBe(parent);
        const current = after?.paypalAuthorizationId as string;
        console.info(`${c.name}: hold_error ${after?.holdError}, current ${current}`);

        if (current === parent) {
          expect(after?.holdError).toMatch(/^REAUTHORIZATION_/);
        } else {
          expect(after?.holdError).toBeNull();
          const child = await call(
            paypal.paypal.payments.getAuthorizedPayment({ authorizationId: current }),
          );
          expect(child.customId).toBe(auth.customId);
          expect(child.supplementaryData?.relatedIds?.orderId).toBe(orderId);
        }
        await tick();
        expect((await row(mid))?.paypalAuthorizationId).toBe(current);
        expect(calls.filter((x) => x === `reauthorizePayment:${parent}`).length).toBe(1);

        await call(
          paypal.paypal.payments.captureAuthorizedPayment({
            authorizationId: current,
            paypalRequestId: randomUUID(),
            body: { amount: { currencyCode: "USD", value: "1.00" }, finalCapture: false },
          }),
        );
        expect(await voidHold(deps, mid, "REVOKED")).toBe("voided");
        console.info(
          `${c.name}: after the void, parent ${await status(paypal, parent)}, current ${await status(paypal, current)}`,
        );
        expect(await status(paypal, parent)).toBe("VOIDED");
      },
    );
  }
});
