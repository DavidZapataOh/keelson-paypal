import { cartHash, sha256, toHex } from "@keelson/core";
import { channel3Observations, eq, mandates, purchases, teeSignatures, user } from "@keelson/db";
import { closeMandate, OPEN_MANDATE_TYP, verifyCredential } from "@keelson/mandate";
import { pino } from "pino";
import { ulid } from "ulid";
import { bytesToHex, hexToBytes } from "viem";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { type Channel3Lookup, createChannel3 } from "../src/channel3/client.ts";
import { failStalePurchases } from "../src/sweeper.ts";
import { LegClient } from "../src/tee/client.ts";
import { createTee } from "../src/tee/config.ts";
import { refreshLeg } from "../src/tee/signers.ts";
import { capturedLookup, channel3Mandate } from "./channel3.ts";
import { EvidenceUploader } from "./evidence.ts";
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
  const appWith = (client = tee.client, channel3?: Channel3Lookup) =>
    createApp({
      db: testDb,
      kv: testKv,
      log,
      appOrigin: APP_ORIGIN,
      authenticate: headerPrincipal,
      tee: { ...tee, client },
      requestTimeoutMs: 60_000,
      ...(channel3 ? { channel3 } : {}),
    });
  const app = appWith();
  let passkey: VirtualPasskey;
  let sub: string;
  let agentKey: CryptoKey;
  let openMandate: string;
  let mandateId: string;
  const evidence = new EvidenceUploader();

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
    /** Stored evidence for this cart unless given; a revoked mandate takes no evidence. */
    root?: `0x${string}`,
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
      evidenceRoot: root ?? (await evidence.upload(app, mandateId, cart.cart, asAgent)),
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
    await evidence.close();
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

  /** The app with both real legs behind a proxy that records every call made to them. */
  const counted = (calls: string[]) => {
    const counting = (leg: LegClient) =>
      new Proxy(leg, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            calls.push(String(prop));
            return value.apply(target, args);
          };
        },
      });
    return appWith({ a: counting(tee.client.a), b: counting(tee.client.b) });
  };
  const send = (target: ReturnType<typeof appWith>, body: unknown) =>
    target.request("/v1/countersign", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": ulid(), ...asAgent },
      body: JSON.stringify(body),
    });

  test("an evidence root not stored for the mandate is refused before any leg is called", async () => {
    const calls: string[] = [];
    const watched = counted(calls);
    const requestId = ulid();
    const body = {
      ...(await countersignBody(carts.demo, requestId)),
      evidenceRoot: `0x${"55".repeat(32)}`,
    };
    const res = await watched.request("/v1/countersign", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": ulid(), ...asAgent },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { type: string }).type).toMatch(/evidence-unknown$/);
    expect(calls).toEqual([]);
    expect(await testDb.select().from(purchases).where(eq(purchases.id, requestId))).toEqual([]);
  });

  test("evidence whose cart is not the countersigned cart is refused before any leg is called", async () => {
    const calls: string[] = [];
    const requestId = ulid();
    const body = await countersignBody(carts.bundle, requestId);
    const demoEvidence = await evidence.upload(app, mandateId, carts.demo.cart, asAgent);
    const res = await send(counted(calls), { ...body, evidenceRoot: demoEvidence });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { type: string }).type).toMatch(/evidence-cart-mismatch$/);
    expect(calls).toEqual([]);
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
      evidenceRoot: Buffer.from(body.evidenceRoot.slice(2), "hex"),
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

  test("an evidence root binds one purchase only", async () => {
    const m = await issue();
    const first = await countersignBody(carts.demo, ulid(), m);
    expect((await send(app, first)).status).toBe(200);
    const calls: string[] = [];
    const again = {
      ...(await countersignBody(carts.demo, ulid(), m)),
      evidenceRoot: first.evidenceRoot,
    };
    const res = await send(counted(calls), again);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { type: string }).type).toMatch(/evidence-used$/);
    expect(calls).toEqual([]);
  });

  // A Channel3 catalog SKU whose selected Color is "Black"; the store's own page calls the same
  // pack "Heather Grey & Black".
  const sku = capturedLookup("shopwss-com");
  const view = (color: string) => ({
    brand: "adidas",
    priceMinor: "2000",
    currency: "USD",
    available: true,
    selected: [{ name: "Color", label: color }],
  });
  const boundTo = async (id: string) =>
    (
      await testDb
        .select({ purchaseId: channel3Observations.purchaseId })
        .from(channel3Observations)
        .where(eq(channel3Observations.id, id))
    )[0]?.purchaseId;

  test.skipIf(!process.env.CHANNEL3_API_KEY)(
    "the Channel3 comparison is in the countersigned trace and never changes a color",
    async () => {
      const observing = appWith(tee.client, createChannel3(process.env.CHANNEL3_API_KEY as string));
      for (const [color, result] of [
        ["Heather Grey & Black", "mismatch"],
        ["Black", "match"],
      ] as const) {
        const m = await issue();
        const capture = await evidence.capture(carts.demo.cart);
        const observation = await evidence.observe(
          observing,
          mandateId,
          capture,
          sku.url,
          view(color),
          asAgent,
        );
        expect(observation.status).toBe("ok");
        const root = await evidence.store(app, mandateId, capture, asAgent, observation);
        const requestId = ulid();
        const res = await send(app, await countersignBody(carts.demo, requestId, m, root));
        const out = (await res.json()) as {
          decision: string;
          trace: { fields: { field: string; color: string; evidence: string[] }[] };
        };
        expect(res.status, JSON.stringify(out)).toBe(200);
        const variant = out.trace.fields.find((f) => f.field === "variant");
        expect(variant?.evidence).toContain(`channel3:${result}:variant:${observation.id}`);
        expect(variant?.color).toBe("amber");
        expect(await boundTo(observation.id)).toBe(requestId);
      }
    },
  );

  test("a Channel3 observation the agent wrote, or one that is not this purchase's, is refused before any leg is called", async () => {
    const m = await issue();
    const calls: string[] = [];
    const watched = counted(calls);
    // Channel3 unreachable: the observation is stored as unavailable, at no credit.
    const observing = appWith(tee.client, createChannel3("unused-key", "http://127.0.0.1:9"));
    const observed = async (owner = mandateId) => {
      const capture = await evidence.capture(carts.demo.cart);
      const observation = await evidence.observe(
        observing,
        owner,
        capture,
        sku.url,
        view("Black"),
        asAgent,
      );
      return { capture, observation };
    };
    const refused = async (root: `0x${string}`, detail: RegExp) => {
      const res = await send(watched, await countersignBody(carts.demo, ulid(), m, root));
      const problem = (await res.json()) as { type: string; detail: string };
      expect(res.status).toBe(422);
      expect(problem.type).toMatch(/observation-invalid$/);
      expect(problem.detail).toMatch(detail);
    };

    const written = {
      ...(await countersignBody(carts.demo, ulid(), m)),
      evidence: { variant: [`channel3:match:variant:${ulid()}`] },
    };
    const res = await send(watched, written);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { type: string }).type).toMatch(/invalid-evidence$/);

    const other = await observed(await channel3Mandate());
    await refused(
      await evidence.store(app, mandateId, other.capture, asAgent, other.observation),
      /another mandate/,
    );

    const stale = await observed();
    await testDb
      .update(channel3Observations)
      .set({ createdAt: new Date(Date.now() - 901_000) })
      .where(eq(channel3Observations.id, stale.observation.id));
    await refused(
      await evidence.store(app, mandateId, stale.capture, asAgent, stale.observation),
      /older than 900/,
    );

    const resalted = await observed();
    const salt = crypto.getRandomValues(new Uint8Array(32));
    await refused(
      await evidence.store(app, mandateId, resalted.capture, asAgent, {
        ...resalted.observation,
        salt,
      }),
      /not issued/,
    );

    // A view said to be read from another item than the evidence's api.product.
    const capture = await evidence.capture(carts.demo.cart);
    const cartItem = capture.items.find((i) => i.type === "api.cart");
    const elsewhere = await evidence.observe(
      observing,
      mandateId,
      capture,
      sku.url,
      { ...view("Black"), contentHash: toHex(sha256(cartItem?.bytes ?? new Uint8Array())) },
      asAgent,
    );
    await refused(
      await evidence.store(app, mandateId, capture, asAgent, elsewhere),
      /api\.product/,
    );
    expect(calls).toEqual([]);

    const used = await observed();
    const requestId = ulid();
    const first = await evidence.store(app, mandateId, used.capture, asAgent, used.observation);
    expect((await send(app, await countersignBody(carts.demo, requestId, m, first))).status).toBe(
      200,
    );
    expect(await boundTo(used.observation.id)).toBe(requestId);
    const again = await evidence.capture(carts.demo.cart);
    await refused(
      await evidence.store(app, mandateId, again, asAgent, used.observation),
      /another purchase/,
    );
    expect(calls).toEqual([]);
  });

  test("a mandate that is not usable cannot countersign", async () => {
    await testDb.update(mandates).set({ state: "REVOKED" }).where(eq(mandates.id, mandateId));
    const unused = `0x${"55".repeat(32)}` as const;
    const res = await post(
      "/v1/countersign",
      await countersignBody(carts.demo, ulid(), { openMandate, agentKey }, unused),
      asAgent,
    );
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
          await countersignBody(carts.demo, ulid(), m, `0x${"55".repeat(32)}`),
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
