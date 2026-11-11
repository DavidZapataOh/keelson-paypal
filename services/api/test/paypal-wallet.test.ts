import { randomBytes } from "node:crypto";
import { eq, paypalWallets, user } from "@keelson/db";
import { pino } from "pino";
import { ulid } from "ulid";
import { describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { createPayPalDeps } from "../src/paypal.ts";
import { testDb, testKv } from "./setup.ts";
import { asUser, headerPrincipal } from "./tee-live.ts";

const log = pino({ level: "silent" });
const base = { db: testDb, kv: testKv, log, authenticate: headerPrincipal };
// Credentials PayPal would refuse: these tests end before any call to PayPal.
const paypal = createPayPalDeps({
  PAYPAL_ENV: "sandbox",
  PAYPAL_CLIENT_ID: "client",
  PAYPAL_CLIENT_SECRET: "secret",
  PAYPAL_MERCHANT_ID: "A4WCRYD5EYDF2",
});
const app = createApp({ ...base, appOrigin: "https://app.keelson.finance", paypal });

async function newUser(): Promise<string> {
  const id = `kls_usr_${randomBytes(8).toString("hex")}`;
  await testDb.insert(user).values({ id, name: "u", email: `${id}@example.test` });
  return id;
}

const post = (path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(path, {
    method: "POST",
    headers: {
      "idempotency-key": ulid(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("saved PayPal", () => {
  test("every route needs a session", async () => {
    expect((await post("/v1/paypal/wallet/setup-token", {})).status).toBe(401);
    expect((await post("/v1/paypal/wallet", {}, { setupToken: "5C991763VB2781612" })).status).toBe(
      401,
    );
    expect((await app.request("/v1/paypal/wallet")).status).toBe(401);
    expect((await app.request("/v1/paypal/wallet", { method: "DELETE" })).status).toBe(401);
  });

  test("a user without a saved PayPal reads and removes nothing", async () => {
    const sub = await newUser();
    expect((await app.request("/v1/paypal/wallet", { headers: asUser(sub) })).status).toBe(404);
    const removed = await app.request("/v1/paypal/wallet", {
      method: "DELETE",
      headers: asUser(sub),
    });
    expect(removed.status).toBe(404);
  });

  test("a user reads their saved PayPal without its vault id", async () => {
    const sub = await newUser();
    await testDb
      .insert(paypalWallets)
      .values({
        userId: sub,
        vaultId: "jwgvx42",
        customerId: "ROaPMoZUa5",
        email: "b@example.com",
      });
    const res = await app.request("/v1/paypal/wallet", { headers: asUser(sub) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ email: "b@example.com", createdAt: expect.any(String) });
    expect(JSON.stringify(body)).not.toContain("jwgvx42");
    await testDb.delete(paypalWallets).where(eq(paypalWallets.userId, sub));
  });

  test("only the user who asked for a setup token can save it", async () => {
    const owner = await newUser();
    const other = await newUser();
    await testKv.set("paypal:setup:5C991763VB2781612", owner, { EX: 60 });
    const res = await post("/v1/paypal/wallet", asUser(other), { setupToken: "5C991763VB2781612" });
    expect(res.status).toBe(404);
    const unknown = await post("/v1/paypal/wallet", asUser(owner), { setupToken: "UNKNOWN0000" });
    expect(unknown.status).toBe(404);
    await testKv.del("paypal:setup:5C991763VB2781612");
  });

  test("answers 503 when PayPal is not configured", async () => {
    const bare = createApp({ ...base, appOrigin: "https://app.keelson.finance" });
    const sub = await newUser();
    expect((await bare.request("/v1/paypal/wallet", { headers: asUser(sub) })).status).toBe(503);
    const setup = await bare.request("/v1/paypal/wallet/setup-token", {
      method: "POST",
      headers: { "idempotency-key": ulid(), ...asUser(sub) },
    });
    expect(setup.status).toBe(503);
  });
});
