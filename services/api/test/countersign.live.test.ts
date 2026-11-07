import { cartHash } from "@keelson/core";
import { eq, mandates, purchases, teeSignatures, user } from "@keelson/db";
import { closeMandate, OPEN_MANDATE_TYP, verifyCredential } from "@keelson/mandate";
import { pino } from "pino";
import { ulid } from "ulid";
import { bytesToHex, hexToBytes } from "viem";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { failStalePurchases } from "../src/sweeper.ts";
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
  registerMandate,
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

  const countersignBody = async (
    cart: (typeof carts)[keyof typeof carts],
    requestId = ulid(),
    m: { openMandate: string; agentKey: CryptoKey } = { openMandate, agentKey },
  ) => {
    const hash = bytesToHex(cartHash(cart.cart)).slice(2);
    return {
      authorizationId: process.env.PAYPAL_AUTHORIZATION_CREATED as string,
      closedMandate: await closeMandate(
        m.openMandate,
        { requestId, cartHash: `sha256:${hash}` },
        m.agentKey,
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
  }, 120_000);
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

  // The sandbox authorization names one mandate id, so every scenario shares the mandate row and
  // takes a new open mandate from leg A: a new commitment has a budget of its own.
  const issue = async () => {
    const agent = await registerMandate(tee.client.a, passkey);
    await testDb
      .insert(user)
      .values({ id: agent.sub, name: "Tester", email: `${agent.sub}@example.test` });
    await testDb
      .update(mandates)
      .set({
        userId: agent.sub,
        openMandate: agent.issued.open_mandate,
        mandateHash: Buffer.from(hexToBytes(agent.issued.mandate_hash)),
      })
      .where(eq(mandates.id, mandateId));
    openMandate = agent.issued.open_mandate;
    agentKey = agent.key;
    return { id: mandateId, openMandate, agentKey };
  };
  const headers = () => ({
    "content-type": "application/json",
    "idempotency-key": ulid(),
    ...asAgent,
  });
  const down = (leg: "a" | "b") =>
    new LegClient(leg, "http://127.0.0.1:9", process.env.KEELSON_TEE_TOKEN as string, 500);

  test("the stored purchase and the response say whether both legs signed", async () => {
    const m = await issue();
    const requestId = ulid();
    const both = await post(
      "/v1/countersign",
      await countersignBody(carts.demo, requestId, m),
      asAgent,
    );
    expect(both.status).toBe(200);
    expect(both.headers.get("keelson-countersign-mode")).toBe("2of2");
    expect(((await both.json()) as { mode: string }).mode).toBe("2of2");
    const [stored] = await testDb.select().from(purchases).where(eq(purchases.id, requestId));
    expect(stored?.countersignMode).toBe("2of2");

    const alone = ulid();
    const body = await countersignBody(carts.demo, alone, await issue());
    const degraded = await appWith({ a: tee.client.a, b: down("b") }).request("/v1/countersign", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });
    expect(degraded.status).toBe(200);
    expect(degraded.headers.get("keelson-countersign-mode")).toBe("degraded");
    expect(((await degraded.json()) as { mode: string }).mode).toBe("degraded");
    const [row] = await testDb.select().from(purchases).where(eq(purchases.id, alone));
    expect(row?.state).toBe("COUNTERSIGNED");
    expect(row?.countersignMode).toBe("degraded");
  });

  test("a request that could outlast leg b's timeout is refused before any leg sees it", async () => {
    const base = await countersignBody(carts.demo);
    const refused = async (patch: Record<string, unknown>) => {
      const res = await post("/v1/countersign", { ...base, ...patch }, asAgent);
      expect(res.status, JSON.stringify(patch).slice(0, 80)).toBe(422);
    };
    const line = carts.demo.cart.lines[0];
    await refused({ cart: { ...carts.demo.cart, lines: Array.from({ length: 33 }, () => line) } });
    await refused({
      evidence: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, ["s"]])),
    });
    await refused({ evidence: { price: Array.from({ length: 9 }, () => "s") } });
    await refused({ evidence: { price: ["x".repeat(257)] } });
    await refused({
      evidence: Object.fromEntries(
        Array.from({ length: 16 }, (_, i) => [
          `f${i}`,
          Array.from({ length: 8 }, () => "x".repeat(100)),
        ]),
      ),
    });
    await refused({ unit: { ...carts.demo.unit, note: "x".repeat(9_000) } });
  });

  test("a purchase that failed because a leg was down is driven again by the same request id", async () => {
    const m = await issue();
    const requestId = ulid();
    const body = await countersignBody(carts.demo, requestId, m);
    const send = (client = tee.client) =>
      appWith(client).request("/v1/countersign", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body),
      });
    const first = await send({ a: down("a"), b: tee.client.b });
    expect(first.status).toBe(503);
    expect(
      (await testDb.select().from(purchases).where(eq(purchases.id, requestId)))[0]?.state,
    ).toBe("FAILED");

    const [one, two] = await Promise.all([send(), send()]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    const [row] = await testDb.select().from(purchases).where(eq(purchases.id, requestId));
    expect(row?.state).toBe("COUNTERSIGNED");
    expect(row?.failureReason).toBeNull();

    const again = await send();
    expect(again.status).toBe(409);
  });

  test("a stale attempt is retried against leg a without reserving the budget twice", async () => {
    const m = await issue();
    const requestId = ulid();
    const body = await countersignBody(carts.demo, requestId, m);
    // The first attempt got as far as leg a, which reserved $94, and then its process died.
    const [mandate] = await testDb.select().from(mandates).where(eq(mandates.id, m.id));
    const reserved = await tee.client.a.countersign({
      request_id: requestId,
      closed_mandate: body.closedMandate,
      sub: mandate?.userId as string,
      cart: body.cart,
      unit: body.unit,
      evidence: {},
      evidence_root: body.evidenceRoot as `0x${string}`,
      authorization_id: body.authorizationId,
    });
    expect(reserved.countersign.decision).toBe("1");
    await testDb.insert(purchases).values({
      id: requestId,
      mandateId: m.id,
      merchantId: carts.demo.cart.merchant,
      currency: carts.demo.cart.currency,
      amountMinor: 9_400n,
      cartHash: Buffer.from(cartHash(carts.demo.cart)),
      state: "EVALUATING",
      updatedAt: new Date(Date.now() - 5 * 60_000),
    });
    expect(await failStalePurchases(testDb)).toBeGreaterThanOrEqual(1);
    const [stale] = await testDb.select().from(purchases).where(eq(purchases.id, requestId));
    expect(stale?.state).toBe("FAILED");
    expect(stale?.failureReason).toBe("stale");

    const retried = await post("/v1/countersign", body, asAgent);
    const result = (await retried.json()) as { decision: string };
    expect(retried.status, JSON.stringify(result)).toBe(200);
    expect(result.decision).toBe("allow");

    const six = structuredClone(carts.demo);
    for (const l of six.cart.lines) l.unit_minor = 600;
    six.unit.amount.value = "6.00";
    six.unit.amount.breakdown.item_total.value = "6.00";
    const fits = await post("/v1/countersign", await countersignBody(six, ulid(), m), asAgent);
    expect(((await fits.json()) as { decision: string }).decision).toBe("allow");
  });

  test("a purchase that failed for any other reason, or for another cart, is not driven again", async () => {
    const m = await issue();
    const requestId = ulid();
    const body = await countersignBody(carts.demo, requestId, m);
    await testDb.insert(purchases).values({
      id: requestId,
      mandateId: m.id,
      merchantId: carts.demo.cart.merchant,
      currency: carts.demo.cart.currency,
      amountMinor: 9_400n,
      cartHash: Buffer.from(cartHash(carts.demo.cart)),
      state: "FAILED",
      failureReason: "tee-divergence",
    });
    expect((await post("/v1/countersign", body, asAgent)).status).toBe(409);

    await testDb
      .update(purchases)
      .set({ failureReason: "tee-unavailable", cartHash: Buffer.alloc(32, 1) })
      .where(eq(purchases.id, requestId));
    const other = await post("/v1/countersign", body, asAgent);
    expect(other.status).toBe(409);
    const [row] = await testDb.select().from(purchases).where(eq(purchases.id, requestId));
    expect(row?.state).toBe("FAILED");
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

  test("the countersign rate limit is kept per caller and mandate", async () => {
    const m = await issue();
    await testDb.update(mandates).set({ state: "REVOKED" }).where(eq(mandates.id, m.id));
    const calls = async (principal: Record<string, string>, n: number) => {
      const statuses: number[] = [];
      for (let i = 0; i < n; i++) {
        const res = await post(
          "/v1/countersign",
          await countersignBody(carts.demo, ulid(), m),
          principal,
        );
        statuses.push(res.status);
      }
      return statuses;
    };
    const client = (subject: string) => ({
      "x-test-principal": JSON.stringify({
        kind: "client",
        subject,
        scopes: ["countersign:write"],
      }),
    });
    const [first, second] = [client(`rate-${ulid()}`), client(`rate-${ulid()}`)];
    // The mandate is revoked, so every call is turned back before it reaches a leg.
    const mine = await calls(first, 61);
    expect([...new Set(mine.slice(0, 60))]).toEqual([409]);
    expect(mine[60]).toBe(429);
    expect(await calls(second, 1)).toEqual([409]);
  });
});
