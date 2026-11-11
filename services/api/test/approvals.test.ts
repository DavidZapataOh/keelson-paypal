import { randomBytes, randomInt } from "node:crypto";
import {
  agentConnections,
  alertEmails,
  eq,
  mandates,
  operators,
  sentEmails,
  user,
} from "@keelson/db";
import { buildSdPayload, parseMandate } from "@keelson/mandate";
import { pino } from "pino";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import demo from "../../../packages/mandate/test/fixtures/demo-mandate.json" with { type: "json" };
import { createApp } from "../src/app.ts";
import { hashDeviceCode } from "../src/connections.ts";
import { createTee } from "../src/tee/config.ts";
import { EvidenceUploader } from "./evidence.ts";
import { testDb, testKv } from "./setup.ts";
import { carts, headerPrincipal } from "./tee-live.ts";

const { cart, unit } = carts.demo;
const total = cart.lines.reduce((s, l) => s + l.qty * l.unit_minor, 0);
const STORE = "https://www.alfred.com";
const userCode = () => {
  const s = Array.from({ length: 8 }, () => "BCDFGHJKLMNPQRSTVWXZ"[randomInt(20)]).join("");
  return `${s.slice(0, 4)}-${s.slice(4)}`;
};
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const closed = (mid: string, requestId: string) =>
  [
    "e30.e30.sig",
    b64(["salt", "mandate", { v: "keelson.mandate.1", mid }]),
    `e30.${b64({ nonce: requestId })}.sig`,
  ].join("~");

describe("a cart above the user's ask-me amount", { timeout: 120_000 }, () => {
  const evidence = new EvidenceUploader();
  // The pause comes before the legs, which are unreachable here.
  const tee = createTee(
    {
      TEE_A_URL: "http://127.0.0.1:9",
      TEE_B_URL: "http://127.0.0.1:9",
      KEELSON_TEE_TOKEN: "unused",
      ARBITRUM_SEPOLIA_RPC_URL: "http://127.0.0.1:9",
    },
    { a: 500, b: 500 },
  );
  const notifier = {
    db: testDb,
    log: pino({ level: "silent" }),
    appOrigin: "https://app.keelson.finance",
    apiOrigin: "https://api.keelson.finance",
    verifyOrigin: "https://verify.keelson.finance",
    secret: randomBytes(32).toString("hex"),
  };
  const app = createApp({
    db: testDb,
    kv: testKv,
    log: pino({ level: "silent" }),
    authenticate: headerPrincipal,
    appOrigin: notifier.appOrigin,
    tee,
    notifier,
  });

  beforeAll(async () => {
    await evidence.capture(cart);
  });
  afterAll(async () => {
    await evidence.close();
  });

  test("is paused with the cart and its checks for the user, who is alerted", async () => {
    const clientId = `agent-${ulid()}`;
    const agent = {
      "x-test-principal": JSON.stringify({
        kind: "client",
        subject: clientId,
        scopes: ["countersign:write", "evidence:write"],
      }),
    };
    const userId = `user-${ulid()}`;
    await testDb.insert(user).values({ id: userId, name: "Buyer", email: `${userId}@x.test` });
    await testDb
      .insert(alertEmails)
      .values({ userId, address: "me@keelson.test", confirmedAt: new Date() });
    const agentId = BigInt(`0x${randomBytes(12).toString("hex")}`);
    await testDb.insert(operators).values({
      agentId,
      chainId: 421614,
      agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
      name: "Anthropic Labs",
      cnfJwk: {},
      clientId,
    });
    const m = parseMandate(structuredClone(demo));
    for (const c of m.checkout.constraints) {
      if (c.type === "checkout.allowed_merchants") {
        c.allowed = c.allowed.map((x) =>
          x.id === cart.merchant ? { ...x, website: `${STORE}/` } : x,
        );
      }
    }
    const mid = ulid();
    const authorizationId = `AUTH${randomBytes(6).toString("hex").toUpperCase()}`;
    await testDb.insert(mandates).values({
      id: mid,
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
      ...(await buildSdPayload(m, () => randomBytes(16))),
    });
    // The user approved this agent's request with "ask me above $10".
    await testDb.insert(agentConnections).values({
      id: ulid(),
      kind: "connect",
      clientId,
      operatorAgentId: agentId,
      name: "Claude Code",
      reason: "Buys running shoes.",
      userCode: userCode(),
      deviceCodeHash: hashDeviceCode(ulid()),
      currency: "USD",
      perPurchaseMinor: 100_000n,
      totalMinor: 100_000n,
      askAboveMinor: 1_000n,
      merchantIds: [cart.merchant],
      notAfter: new Date(Date.now() + 86_400_000),
      state: "APPROVED",
      userId,
      mandateId: mid,
      expiresAt: new Date(Date.now() + 900_000),
    });

    const requestId = ulid();
    const res = await app.request("/v1/countersign", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": ulid(), ...agent },
      body: JSON.stringify({
        authorizationId,
        closedMandate: closed(mid, requestId),
        cart,
        unit,
        evidenceRoot: await evidence.upload(app, mid, cart, agent),
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { type: string; approval: { user_code: string } };
    expect(body.type).toMatch(/\/approval-required$/);

    const view = await (
      await app.request(`/v1/connections/${body.approval.user_code}`, {
        headers: { "x-test-principal": JSON.stringify({ kind: "user", subject: userId }) },
      })
    ).json();
    expect(view.kind).toBe("once");
    expect(view.agent).toMatchObject({ agentId: agentId.toString(), operator: "Anthropic Labs" });
    expect(view.cart).toMatchObject({
      merchant: { id: cart.merchant },
      currency: "USD",
      totalMinor: String(total),
    });
    expect(view.cart.lines).toHaveLength(cart.lines.length);
    const fields = view.checks.map((c: { field: string }) => c.field);
    expect(fields).toEqual(expect.arrayContaining(["total", "merchant", "askAbove"]));
    expect(view.checks.find((c: { field: string }) => c.field === "askAbove")).toEqual({
      field: "askAbove",
      mandate: "$10.00",
      cart: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
        total / 100,
      ),
      pass: false,
    });
    for (const field of ["total", "budget", "merchant"]) {
      expect(view.checks.find((c: { field: string }) => c.field === field).pass).toBe(true);
    }

    const mail = await vi.waitFor(async () => {
      const [row] = await testDb.select().from(sentEmails).where(eq(sentEmails.userId, userId));
      if (!row) throw new Error("not yet");
      return row;
    });
    expect(mail.event).toBe("approval.requested");
    expect(mail.subject).toMatch(/^Claude Code wants \$[\d,.]+ at /);
  });
});
