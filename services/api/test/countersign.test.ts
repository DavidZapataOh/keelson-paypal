import { randomBytes } from "node:crypto";
import { cartHash } from "@keelson/core";
import { eq, mandates, operators, purchases, user } from "@keelson/db";
import { pino } from "pino";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { createTee } from "../src/tee/config.ts";
import { EvidenceUploader } from "./evidence.ts";
import { testDb, testKv } from "./setup.ts";
import { carts, headerPrincipal } from "./tee-live.ts";

const CLIENT = "countersign-test";
const agent = {
  "x-test-principal": JSON.stringify({
    kind: "client",
    subject: CLIENT,
    scopes: ["countersign:write", "evidence:write"],
  }),
};
const { cart, unit } = carts.demo;
const hash = Buffer.from(cartHash(cart));
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * A closed mandate shaped as the API reads it: the mandate id in a disclosure and the request id
 * as the key binding's nonce. The legs, which verify the credential, are never reached here.
 */
const closed = (mid: string, requestId: string) =>
  [
    "e30.e30.sig",
    b64(["salt", "mandate", { v: "keelson.mandate.1", mid }]),
    `e30.${b64({ nonce: requestId })}.sig`,
  ].join("~");

/** An active mandate held as a whole, of an operator the test client linked. */
async function heldMandate() {
  const userId = `user-${ulid()}`;
  await testDb.insert(user).values({ id: userId, name: "Tester", email: `${userId}@example.test` });
  const agentId = BigInt(`0x${randomBytes(12).toString("hex")}`);
  await testDb.insert(operators).values({
    agentId,
    chainId: 421614,
    agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
    name: "op",
    cnfJwk: {},
    clientId: CLIENT,
  });
  const id = ulid();
  const authorizationId = `AUTH${randomBytes(6).toString("hex").toUpperCase()}`;
  await testDb.insert(mandates).values({
    id,
    userId,
    operatorAgentId: agentId,
    state: "ACTIVE",
    currency: "USD",
    maxMinor: 100_000n,
    remainingMinor: 100_000n,
    merchantIds: [cart.merchant],
    expiresAt: new Date(Date.now() + 86_400_000),
    openMandate: "open",
    mandateHash: randomBytes(32),
    holdMode: "mandate",
    paypalOrderId: `ORDER${randomBytes(6).toString("hex").toUpperCase()}`,
    paypalAuthorizationId: authorizationId,
  });
  return { id, authorizationId };
}

/** A purchase of the demo cart already on the mandate. */
async function prior(
  mandateId: string,
  state: (typeof purchases.$inferInsert)["state"],
  capturedMinutesAgo?: number,
) {
  const id = ulid();
  await testDb.insert(purchases).values({
    id,
    mandateId,
    state,
    merchantId: cart.merchant,
    currency: cart.currency,
    amountMinor: 13_900n,
    cartHash: hash,
    ...(capturedMinutesAgo === undefined
      ? {}
      : { capturedAt: new Date(Date.now() - capturedMinutesAgo * 60_000) }),
  });
  return id;
}

describe("countersigning the same cart again", { timeout: 120_000 }, () => {
  const evidence = new EvidenceUploader();
  // Unreachable legs: a countersign that passes the API's own checks fails at the legs.
  const tee = createTee(
    {
      TEE_A_URL: "http://127.0.0.1:9",
      TEE_B_URL: "http://127.0.0.1:9",
      KEELSON_TEE_TOKEN: "unused",
      ARBITRUM_SEPOLIA_RPC_URL: "http://127.0.0.1:9",
    },
    { a: 500, b: 500 },
  );
  const app = createApp({
    db: testDb,
    kv: testKv,
    log: pino({ level: "silent" }),
    authenticate: headerPrincipal,
    tee,
  });

  async function countersign(
    m: { id: string; authorizationId: string },
    extra: Record<string, unknown> = {},
    requestId = ulid(),
    principal = agent,
  ) {
    const res = await app.request("/v1/countersign", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": ulid(), ...principal },
      body: JSON.stringify({
        authorizationId: m.authorizationId,
        closedMandate: closed(m.id, requestId),
        cart,
        unit,
        ...extra,
        evidenceRoot: extra.evidenceRoot ?? (await evidence.upload(app, m.id, cart, agent)),
      }),
    });
    const body = (await res.json()) as { type?: string; purchaseId?: string };
    const [row] = await testDb.select().from(purchases).where(eq(purchases.id, requestId));
    return { res, body, row };
  }

  beforeAll(async () => {
    await evidence.capture(cart);
  });
  afterAll(async () => {
    await evidence.close();
  });

  test("while the first purchase is in flight, the answer names it and nothing is bought", async () => {
    for (const state of ["PROPOSED", "EVALUATING", "COUNTERSIGNED", "LOGGED", "COVERED"] as const) {
      const m = await heldMandate();
      const first = await prior(m.id, state);
      const { res, body, row } = await countersign(m);
      expect(res.status).toBe(409);
      expect(body.type).toMatch(/\/purchase-exists$/);
      expect(body.purchaseId).toBe(first);
      expect(res.headers.get("location")).toBe(`/v1/purchases/${first}`);
      expect(row).toBeUndefined();
    }
  });

  test("a purchase captured in the last ten minutes is named too", async () => {
    const m = await heldMandate();
    const first = await prior(m.id, "CAPTURED", 3);
    const { res, body, row } = await countersign(m);
    expect(res.status).toBe(409);
    expect(body.purchaseId).toBe(first);
    expect(row).toBeUndefined();
  });

  test("a capture older than ten minutes, a deny or a failure does not stop the purchase", async () => {
    const m = await heldMandate();
    await prior(m.id, "SETTLED", 11);
    await prior(m.id, "DENIED");
    await prior(m.id, "FAILED");
    const { res, body, row } = await countersign(m);
    expect(res.status).toBe(503);
    expect(body.type).toMatch(/\/tee-unavailable$/);
    expect(row?.state).toBe("FAILED");
    expect(row?.cartHash.equals(hash)).toBe(true);
  });

  test("another cart on the same mandate is not held back", async () => {
    const m = await heldMandate();
    await testDb.insert(purchases).values({
      id: ulid(),
      mandateId: m.id,
      state: "COUNTERSIGNED",
      merchantId: cart.merchant,
      currency: cart.currency,
      amountMinor: 100n,
      cartHash: randomBytes(32),
    });
    const { res, row } = await countersign(m);
    expect(res.status).toBe(503);
    expect(row).toBeDefined();
  });

  test("naming the latest purchase of the cart as repeatOf buys it again on purpose", async () => {
    const m = await heldMandate();
    const older = await prior(m.id, "CAPTURED", 5);
    const latest = await prior(m.id, "CAPTURED", 1);

    const stale = await countersign(m, { repeatOf: older });
    expect(stale.res.status).toBe(409);
    expect(stale.body.purchaseId).toBe(latest);
    expect(stale.row).toBeUndefined();

    const again = await countersign(m, { repeatOf: latest });
    expect(again.res.status).toBe(503);
    expect(again.row).toBeDefined();
  });

  test("a retry of a deliberate repeat names the repeat it lost, not the purchase it repeated", async () => {
    const m = await heldMandate();
    const first = await prior(m.id, "CAPTURED", 2);
    const repeat = await prior(m.id, "COUNTERSIGNED");
    const retry = await countersign(m, { repeatOf: first });
    expect(retry.res.status).toBe(409);
    expect(retry.body.purchaseId).toBe(repeat);
  });

  test("a capture that failed after it was sent holds the cart back like a capture", async () => {
    const m = await heldMandate();
    const first = await prior(m.id, "FAILED");
    await testDb
      .update(purchases)
      .set({ failureReason: "capture:amount-mismatch" })
      .where(eq(purchases.id, first));
    const { res, body } = await countersign(m);
    expect(res.status).toBe(409);
    expect(body.purchaseId).toBe(first);
  });

  test("retrying a failed request while another purchase of the cart is in flight is refused", async () => {
    const m = await heldMandate();
    const failed = await countersign(m);
    expect(failed.row?.state).toBe("FAILED");
    const other = await prior(m.id, "COUNTERSIGNED");
    const retry = await countersign(m, {}, failed.row?.id);
    expect(retry.res.status).toBe(409);
    expect(retry.body.purchaseId).toBe(other);
    expect(retry.row?.state).toBe("FAILED");
  });

  test("a live purchase records the store it is paid at; the store must be an origin", async () => {
    const m = await heldMandate();
    const { row } = await countersign(m, { live: { store: "https://www.alfred.com" } });
    expect(row?.liveStore).toBe("https://www.alfred.com");
    for (const store of ["https://www.alfred.com/cart", "http://www.alfred.com"]) {
      const bad = await countersign(m, { live: { store } });
      expect(bad.res.status).toBe(422);
      expect(bad.row).toBeUndefined();
    }
  });

  test("a mandate whose merchant Keelson cannot capture for countersigns only live purchases", async () => {
    // The mandate allows no payee Keelson captures for: its hold can only back a budget.
    const withPayPal = createApp({
      db: testDb,
      kv: testKv,
      log: pino({ level: "silent" }),
      authenticate: headerPrincipal,
      tee,
      paypal: { merchantId: "A4WCRYD5EYDF2" } as never,
    });
    const m = await heldMandate();
    const send = async (live: boolean) => {
      const requestId = ulid();
      const res = await withPayPal.request("/v1/countersign", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": ulid(), ...agent },
        body: JSON.stringify({
          authorizationId: m.authorizationId,
          closedMandate: closed(m.id, requestId),
          cart,
          unit,
          evidenceRoot: await evidence.upload(withPayPal, m.id, cart, agent),
          ...(live ? { live: { store: "https://www.alfred.com" } } : {}),
        }),
      });
      const [row] = await testDb.select().from(purchases).where(eq(purchases.id, requestId));
      return { res, row, body: (await res.json()) as { type?: string } };
    };
    const captured = await send(false);
    expect(captured.res.status).toBe(422);
    expect(captured.body.type).toMatch(/merchant-not-capturable$/);
    expect(captured.row).toBeUndefined();
    expect((await send(true)).row?.liveStore).toBe("https://www.alfred.com");
  });

  test("only the client the operator linked countersigns under its mandates", async () => {
    const m = await heldMandate();
    const evidenceRoot = await evidence.upload(app, m.id, cart, agent);
    for (const subject of ["another-client", null]) {
      if (subject === null) {
        await testDb
          .update(operators)
          .set({ clientId: null })
          .where(
            eq(
              operators.agentId,
              (await testDb.select().from(mandates).where(eq(mandates.id, m.id)))[0]
                ?.operatorAgentId as bigint,
            ),
          );
      }
      const caller = {
        "x-test-principal": JSON.stringify({
          kind: "client",
          subject: subject ?? CLIENT,
          scopes: ["countersign:write", "evidence:write"],
        }),
      };
      const { res, row } = await countersign(m, { evidenceRoot }, ulid(), caller);
      expect(res.status).toBe(404);
      expect(row).toBeUndefined();
    }
  });
});
