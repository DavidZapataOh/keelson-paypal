import { randomBytes } from "node:crypto";
import { eq, paypalWallets, user } from "@keelson/db";
import { PayPalError } from "@keelson/paypal";
import { approveOrder } from "@keelson/paypal/testing";
import { pino } from "pino";
import { ulid } from "ulid";
import { describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { applyEvent, type EventRow } from "../src/paypal/apply.ts";
import { call } from "../src/paypal.ts";
import { APP_ORIGIN, sandbox } from "./hold-live.ts";
import { testDb, testKv } from "./setup.ts";
import { asUser, headerPrincipal, live } from "./tee-live.ts";

const log = pino({ level: "silent" });

describe.runIf(live)("saved PayPal (sandbox, Vault)", { timeout: 300_000 }, () => {
  const paypal = live ? sandbox() : (undefined as never);
  const app = createApp({
    db: testDb,
    kv: testKv,
    log,
    appOrigin: APP_ORIGIN,
    authenticate: headerPrincipal,
    paypal,
    requestTimeoutMs: 60_000,
  });
  const post = (path: string, sub: string, body?: unknown) =>
    app.request(path, {
      method: "POST",
      headers: {
        "idempotency-key": ulid(),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...asUser(sub),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  /** A new user whose PayPal is the sandbox buyer's, approved once in PayPal. */
  async function savedBuyer(): Promise<{ sub: string; vaultId: string }> {
    const sub = `kls_usr_${randomBytes(8).toString("hex")}`;
    await testDb.insert(user).values({ id: sub, name: "u", email: `${sub}@example.test` });
    const setup = await post("/v1/paypal/wallet/setup-token", sub);
    expect(setup.status).toBe(201);
    const { setupToken } = (await setup.json()) as { setupToken: string };
    const token = await call(paypal.paypal.vault.getSetupToken(setupToken));
    const approve = token.links?.find((l) => l.rel === "approve")?.href;
    if (!approve) throw new Error("the setup token has no approve link");
    await approveOrder(approve, `${APP_ORIGIN}/passkeys`);
    const saved = await post("/v1/paypal/wallet", sub, { setupToken });
    expect(saved.status).toBe(201);
    expect(await saved.json()).toEqual({
      email: process.env.PAYPAL_SANDBOX_BUYER_EMAIL,
      createdAt: expect.any(String),
    });
    const [row] = await testDb.select().from(paypalWallets).where(eq(paypalWallets.userId, sub));
    return { sub, vaultId: row?.vaultId as string };
  }

  const gone = async (vaultId: string) => {
    const err = await call(paypal.paypal.vault.getPaymentToken(vaultId)).catch((e: unknown) => e);
    return err instanceof PayPalError && err.status === 404;
  };

  test("a user saves PayPal once, reads it and removes it, which deletes it at PayPal", async () => {
    const { sub, vaultId } = await savedBuyer();
    expect((await app.request("/v1/paypal/wallet", { headers: asUser(sub) })).status).toBe(200);
    const removed = await app.request("/v1/paypal/wallet", {
      method: "DELETE",
      headers: asUser(sub),
    });
    expect(removed.status).toBe(204);
    expect(await gone(vaultId)).toBe(true);
    expect((await app.request("/v1/paypal/wallet", { headers: asUser(sub) })).status).toBe(404);
  });

  test("PayPal's deletion event forgets the saved PayPal once PayPal no longer has it", async () => {
    const { sub, vaultId } = await savedBuyer();
    const row = { eventType: "VAULT.PAYMENT-TOKEN.DELETED", resourceId: vaultId } as EventRow;
    expect((await applyEvent({ db: testDb, kv: testKv, log, paypal }, row)).status).toBe("ignored");
    await call(paypal.paypal.vault.deletePaymentToken(vaultId));
    expect((await applyEvent({ db: testDb, kv: testKv, log, paypal }, row)).status).toBe("applied");
    expect(await testDb.select().from(paypalWallets).where(eq(paypalWallets.userId, sub))).toEqual(
      [],
    );
  });
});
