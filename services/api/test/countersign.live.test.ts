import { cartHash } from "@keelson/core";
import { eq, mandates, purchases, teeSignatures, user } from "@keelson/db";
import { closeMandate, OPEN_MANDATE_TYP, verifyCredential } from "@keelson/mandate";
import { pino } from "pino";
import { ulid } from "ulid";
import { bytesToHex } from "viem";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { LegClient } from "../src/tee/client.ts";
import { createTee } from "../src/tee/config.ts";
import { refreshLeg } from "../src/tee/signers.ts";
import { testDb, testKv } from "./setup.ts";
import {
  asAgent,
  asUser,
  carts,
  headerPrincipal,
  live,
  liveEnv,
  seedUser,
  signedMandate,
  VirtualPasskey,
} from "./tee-live.ts";

const APP_ORIGIN = "https://app.keelson.finance";

describe.skipIf(!live)("POST /v1/countersign (live legs)", { timeout: 180_000 }, () => {
  const tee = createTee(liveEnv(), { a: 10_000, b: 10_000 });
  const log = pino({ level: "silent" });
  const appWith = (client = tee.client) =>
    createApp({
      db: testDb,
      kv: testKv,
      log,
      appOrigin: APP_ORIGIN,
      authenticate: headerPrincipal,
      tee: { ...tee, client },
      requestTimeoutMs: 60_000,
    });
  const app = appWith();
  let passkey: VirtualPasskey;
  let sub: string;
  let agentKey: CryptoKey;
  let openMandate: string;
  let mandateId: string;

  const post = (path: string, body: unknown, headers: Record<string, string>, key = ulid()) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key, ...headers },
      body: JSON.stringify(body),
    });

  const countersignBody = async (cart: (typeof carts)[keyof typeof carts], requestId = ulid()) => {
    const hash = bytesToHex(cartHash(cart.cart)).slice(2);
    return {
      authorizationId: process.env.PAYPAL_AUTHORIZATION_CREATED as string,
      closedMandate: await closeMandate(
        openMandate,
        { requestId, cartHash: `sha256:${hash}` },
        agentKey,
      ),
      cart: cart.cart,
      unit: cart.unit,
      evidenceRoot: `0x${"55".repeat(32)}`,
    };
  };

  beforeAll(async () => {
    passkey = await VirtualPasskey.create();
    await refreshLeg(testDb, "a", tee);
    await refreshLeg(testDb, "b", tee);
    const signed = await signedMandate(passkey);
    sub = signed.sub;
    agentKey = signed.key;
    await seedUser(testDb, passkey, sub);
    const created = await post("/v1/mandates", signed.body, asUser(sub));
    const json = (await created.json()) as { id: string; openMandate: string };
    expect(created.status, JSON.stringify(json)).toBe(201);
    openMandate = json.openMandate;
    mandateId = json.id;
  });
  afterAll(async () => {
    await passkey.close();
  });

  test("the mandate route stores the open mandate the TEE issued", async () => {
    const [row] = await testDb.select().from(mandates).where(eq(mandates.id, mandateId));
    expect(row?.openMandate).toBe(openMandate);
    expect(row?.sealedSalt?.length).toBeGreaterThan(16);
    const [holder] = await testDb.select().from(user).where(eq(user.id, sub));
    expect(holder?.userCredential).toMatch(/~$/);

    const issuer = await tee.client.a
      .health()
      .then((h) => (h as unknown as { issuer: object }).issuer);
    const verified = await verifyCredential(
      openMandate,
      OPEN_MANDATE_TYP,
      await crypto.subtle.importKey("jwk", issuer, { name: "ECDSA", namedCurve: "P-256" }, true, [
        "verify",
      ]),
      {
        expectedAud: "keelson.finance",
        expectedNonce: mandateId,
        now: Math.floor(Date.now() / 1000),
        maxSkewSec: 60,
      },
    );
    expect(verified.mandate.mid).toBe(mandateId);
  });

  test("the demo cart is allowed, countersigned by both legs, and the retry returns the stored result", async () => {
    const requestId = ulid();
    const body = await countersignBody(carts.demo, requestId);
    const key = ulid();
    const first = await post("/v1/countersign", body, asAgent, key);
    const result = (await first.json()) as Record<string, unknown>;
    expect(first.status, JSON.stringify(result)).toBe(200);
    expect(result.decision).toBe("allow");
    expect(result.mode).toBe("2of2");
    expect((result.signatures as { nitro: string }).nitro).toMatch(/^0x[0-9a-f]{130}$/);
    const [purchase] = await testDb.select().from(purchases).where(eq(purchases.id, requestId));
    expect(purchase?.state).toBe("COUNTERSIGNED");
    expect(purchase?.decision).toBe(1);

    const again = await post("/v1/countersign", body, asAgent, key);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(await again.json()).toEqual(result);
    const signatures = await testDb
      .select()
      .from(teeSignatures)
      .where(eq(teeSignatures.requestId, requestId));
    expect(signatures).toHaveLength(2);
  });

  test("the budget was reserved once: the next $94 cart is denied, a $6 one fits", async () => {
    const second = await post("/v1/countersign", await countersignBody(carts.demo), asAgent);
    const denied = (await second.json()) as {
      decision: string;
      countersign: { failedFieldsMask: string };
    };
    expect(second.status).toBe(200);
    expect(denied.decision).toBe("deny");
    expect(Number(denied.countersign.failedFieldsMask) & (1 << 4)).not.toBe(0);

    const six = structuredClone(carts.demo);
    for (const line of six.cart.lines) line.unit_minor = 600;
    six.unit.amount.value = "6.00";
    six.unit.amount.breakdown.item_total.value = "6.00";
    const fits = await post("/v1/countersign", await countersignBody(six), asAgent);
    expect(((await fits.json()) as { decision: string }).decision).toBe("allow");
  });

  test("a $340 bundle is a countersigned deny and the purchase is DENIED", async () => {
    const requestId = ulid();
    const res = await post(
      "/v1/countersign",
      await countersignBody(carts.bundle, requestId),
      asAgent,
    );
    const out = (await res.json()) as { decision: string; signatures: { nitro: string | null } };
    expect(res.status).toBe(200);
    expect(out.decision).toBe("deny");
    expect(out.signatures.nitro).not.toBeNull();
    const [purchase] = await testDb.select().from(purchases).where(eq(purchases.id, requestId));
    expect(purchase?.state).toBe("DENIED");
  });

  test("callers without the countersign scope are refused", async () => {
    const body = await countersignBody(carts.demo);
    expect((await post("/v1/countersign", body, {})).status).toBe(401);
    expect((await post("/v1/countersign", body, asUser(sub))).status).toBe(403);
  });

  test("leg a unreachable answers 503 tee-unavailable and fails the purchase", async () => {
    const down = new LegClient(
      "a",
      "http://127.0.0.1:9",
      process.env.KEELSON_TEE_TOKEN as string,
      500,
    );
    const requestId = ulid();
    const res = await appWith({ a: down, b: tee.client.b }).request("/v1/countersign", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": ulid(), ...asAgent },
      body: JSON.stringify(await countersignBody(carts.demo, requestId)),
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { type: string }).type).toMatch(/tee-unavailable$/);
    const [purchase] = await testDb.select().from(purchases).where(eq(purchases.id, requestId));
    expect(purchase?.state).toBe("FAILED");
    expect(purchase?.failureReason).toBe("tee-unavailable");
  });

  test("a divergence is a 502 with no signature in the body", async () => {
    const tampered = Object.create(tee.client.b) as LegClient;
    tampered.countersign = (r) => {
      const cart = structuredClone(r.cart) as { lines: { unit_minor: number }[] };
      for (const line of cart.lines) line.unit_minor += 1;
      return tee.client.b.countersign({ ...r, cart });
    };
    const requestId = ulid();
    const res = await appWith({ a: tee.client.a, b: tampered }).request("/v1/countersign", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": ulid(), ...asAgent },
      body: JSON.stringify(await countersignBody(carts.demo, requestId)),
    });
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(text).toMatch(/tee-divergence/);
    expect(text).not.toMatch(/0x[0-9a-f]{130}/);
    const [purchase] = await testDb.select().from(purchases).where(eq(purchases.id, requestId));
    expect(purchase?.state).toBe("FAILED");
  });

  test("issuing a mandate with leg a down answers 503 and stores nothing", async () => {
    const down = new LegClient(
      "a",
      "http://127.0.0.1:9",
      process.env.KEELSON_TEE_TOKEN as string,
      500,
    );
    const signed = await signedMandate(passkey, sub);
    const before = await testDb.select().from(mandates);
    const res = await appWith({ a: down, b: tee.client.b }).request("/v1/mandates", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": ulid(), ...asUser(sub) },
      body: JSON.stringify(signed.body),
    });
    expect(res.status).toBe(503);
    expect(await testDb.select().from(mandates)).toHaveLength(before.length);
  });

  test("a mandate that is not usable cannot countersign", async () => {
    await testDb.update(mandates).set({ state: "REVOKED" }).where(eq(mandates.id, mandateId));
    const res = await post("/v1/countersign", await countersignBody(carts.demo), asAgent);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { type: string }).type).toMatch(/mandate-not-active$/);
  });
});
