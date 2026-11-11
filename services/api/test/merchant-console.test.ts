import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { serve } from "@hono/node-server";
import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  alibis,
  attacks,
  disputes,
  eq,
  mandates,
  merchantSettlement,
  operators,
  purchases,
  redTeamCampaigns,
  user,
  verdicts,
} from "@keelson/db";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { pino } from "pino";
import { ulid } from "ulid";
import { generatePrivateKey, type LocalAccount, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth.ts";
import { authenticate } from "../src/middleware/auth.ts";
import {
  costMicros,
  DAILY_BUDGET_MICROS,
  FALLBACK_BUDGET_MICROS,
  reserve,
  settle,
  worstCase,
} from "../src/routes/merchant-assistant.ts";
import { settlementPreferenceTypedData } from "../src/routes/merchants-settlement.ts";
import { testAuthEnv, testDb, testKv } from "./setup.ts";

const runfast = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const secret = randomBytes(32).toString("base64url");
let app!: OpenAPIHono;
const server = serve({ fetch: (req) => app.fetch(req), port: 0, hostname: "127.0.0.1" });
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const auth = createAuth(testDb, testAuthEnv(baseURL, secret), { mrc_runfast: runfast.address });
app = createApp({
  db: testDb,
  kv: testKv,
  log: pino({ level: "silent" }),
  auth,
  authenticate: authenticate(auth, baseURL),
  merchantSigners: { mrc_runfast: runfast.address },
});

const helpers = betterAuth({
  database: drizzleAdapter(testDb, { provider: "pg" }),
  secret,
  baseURL,
  plugins: [testUtils()],
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** Signs in with EIP-4361 as `account`, as the console does, and returns the session cookie. */
async function signIn(account: LocalAccount, chainId = 421614): Promise<string> {
  const nonceRes = await fetch(`${baseURL}/api/auth/siwe/nonce`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseURL },
    body: "{}",
  });
  expect(nonceRes.status).toBe(200);
  const { nonce } = (await nonceRes.json()) as { nonce: string };
  const message = createSiweMessage({
    domain: new URL(baseURL).host,
    address: account.address,
    statement: "Sign in to the Keelson merchant console.",
    uri: baseURL,
    version: "1",
    chainId,
    nonce,
    expirationTime: new Date(Date.now() + 600_000),
  });
  const res = await fetch(`${baseURL}/api/auth/siwe/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseURL },
    body: JSON.stringify({ message, signature: await account.signMessage({ message }) }),
  });
  if (res.status !== 200) return "";
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

const get = (path: string, cookie?: string) =>
  fetch(`${baseURL}${path}`, { headers: cookie ? { cookie } : {} });

let merchantCookie = "";
let strangerCookie = "";
let purchaseId = "";
let disputeId = "";

beforeAll(async () => {
  await testDb.delete(merchantSettlement);
  const userId = ulid();
  await testDb.insert(user).values({ id: userId, name: "Buyer", email: `${userId}@example.test` });
  const agentId = BigInt(Date.now());
  await testDb.insert(operators).values({
    agentId,
    chainId: 421614,
    agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
    name: "op",
    cnfJwk: {},
  });
  const mandateId = ulid();
  await testDb.insert(mandates).values({
    id: mandateId,
    userId,
    operatorAgentId: agentId,
    currency: "USD",
    maxMinor: 20_000n,
    remainingMinor: 20_000n,
    merchantIds: ["mrc_runfast"],
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  purchaseId = ulid();
  await testDb.insert(purchases).values({
    id: purchaseId,
    mandateId,
    merchantId: "mrc_runfast",
    currency: "USD",
    amountMinor: 13_900n,
    cartHash: randomBytes(32),
    state: "SLASHED",
    evalTrace: {
      decision: "allow",
      fields: [
        { id: "amount", color: "green", pass: true },
        { id: "variant", color: "amber", pass: false },
      ],
    },
  });
  await testDb.insert(alibis).values({ purchaseId, leafHash: randomBytes(32), bundle: {} });
  disputeId = `PP-D-${Date.now()}`;
  await testDb.insert(disputes).values({
    id: disputeId,
    purchaseId,
    reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
    state: "RESOLVED",
    raw: {},
  });
  await testDb.insert(verdicts).values({
    id: ulid(),
    disputeId,
    liable: 1,
    ruleId: 61,
    amountMinor: 13_900n,
    currency: "USD",
    payee: runfast.address,
    digest: randomBytes(32),
    chainId: 421614,
    message: {},
    signatures: [],
    facts: {},
    rail: "pyusd",
    outcome: "paid",
    paidBy: "chain",
    txHash: randomBytes(32),
    settledAt: new Date(),
  });
  const campaign = ulid();
  await testDb.insert(redTeamCampaigns).values({
    id: campaign,
    header: JSON.stringify({ kind: "header", config: { agentId: "351" } }),
  });
  const line = (store: string) =>
    JSON.stringify({
      kind: "attack",
      model: "claude-haiku-4-5",
      backbone: "vulnerable",
      class: "inflate",
      quote: { cart: { merchant: store } },
      trace: {
        decision: "deny",
        fields: [
          { id: "amount", color: "green", pass: false },
          { id: "budget", color: "green", pass: false },
          { id: "merchant", color: "green", pass: true },
        ],
      },
    });
  for (const [seq, store] of ["mrc_runfast", "mrc_elsewhere"].entries()) {
    await testDb.insert(attacks).values({
      id: ulid(),
      campaign,
      seq,
      backbone: "vulnerable",
      payloadHash: randomBytes(32),
      outcome: "BLOCKED",
      line: line(store),
      hash: randomBytes(32),
    });
  }
  merchantCookie = await signIn(runfast);
  // A signed-in user who is no merchant: a shopper's session.
  const { test: utils } = await helpers.$context;
  const shopper = await utils.saveUser(utils.createUser());
  strangerCookie = (await utils.getAuthHeaders({ userId: shopper.id })).get("cookie") as string;
});

describe("merchant sign-in", () => {
  test("the settlement wallet signs in as its merchant", async () => {
    expect(merchantCookie).not.toBe("");
    const res = await get("/v1/merchants/me", merchantCookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      merchant_id: "mrc_runfast",
      name: "RunFast",
      settlement_address: runfast.address,
    });
  });

  test("no other wallet can sign in", async () => {
    expect(await signIn(stranger)).toBe("");
  });

  test("a session that is no merchant's reads nothing", async () => {
    expect((await get("/v1/merchants/me", strangerCookie)).status).toBe(403);
    expect((await get("/v1/merchants/mrc_runfast/disputes", strangerCookie)).status).toBe(403);
  });

  test("signed out, every merchant read is refused", async () => {
    for (const path of [
      "me",
      "mrc_runfast/settlement",
      "mrc_runfast/disputes",
      "mrc_runfast/evaluations",
    ]) {
      expect((await get(`/v1/merchants/${path}`)).status).toBe(401);
    }
  });

  test("a wallet signing on another chain is refused", async () => {
    expect(await signIn(privateKeyToAccount(generatePrivateKey()), 1)).toBe("");
  });
});

describe("merchant console reads", () => {
  test("the dispute queue carries the verdict, the payer and the Alibi", async () => {
    const res = await get("/v1/merchants/mrc_runfast/disputes", merchantCookie);
    expect(res.status).toBe(200);
    const { disputes: rows } = (await res.json()) as { disputes: Record<string, unknown>[] };
    const row = rows.find((r) => r.dispute_id === disputeId);
    expect(row).toMatchObject({
      purchase_id: purchaseId,
      amount_minor: "13900",
      liable: "operator",
      rule: "R61",
      rail: "pyusd",
      outcome: "paid",
      paid_by: "chain",
      has_alibi: true,
    });
    expect(row?.explorer_url).toMatch(/^https:\/\/.+\/tx\/0x[0-9a-f]{64}$/);
  });

  test("a merchant reads only its own path", async () => {
    expect((await get("/v1/merchants/mrc_other/disputes", merchantCookie)).status).toBe(403);
  });

  test("orders list allowed and blocked carts, with what the cart had but not the mandate's bound", async () => {
    const [bought] = await testDb.select().from(purchases).where(eq(purchases.id, purchaseId));
    const blockedId = ulid();
    await testDb.insert(purchases).values({
      id: blockedId,
      mandateId: (bought as typeof purchases.$inferSelect).mandateId,
      merchantId: "mrc_runfast",
      currency: "USD",
      amountMinor: 34_000n,
      cartHash: randomBytes(32),
      state: "DENIED",
      evalTrace: {
        decision: "deny",
        fields: [{ id: "total", field: "total", pass: false, bound: 10_000, observed: 34_000 }],
      },
    });
    try {
      const res = await get("/v1/merchants/mrc_runfast/orders", merchantCookie);
      expect(res.status).toBe(200);
      const { orders } = (await res.json()) as { orders: Record<string, unknown>[] };
      expect(orders.find((o) => o.purchase_id === blockedId)).toEqual({
        purchase_id: blockedId,
        created_at: expect.any(String),
        state: "DENIED",
        amount_minor: "34000",
        currency: "USD",
        agent_id: expect.any(String),
        has_alibi: false,
        blocked: [{ field: "total", cart: "$340.00" }],
        dispute: null,
      });
      expect(orders.find((o) => o.purchase_id === purchaseId)).toMatchObject({
        state: "SLASHED",
        has_alibi: true,
        blocked: [],
        dispute: { dispute_id: disputeId, state: "RESOLVED", liable: "operator" },
      });
      expect(JSON.stringify(orders)).not.toContain("$100.00");
      expect((await get("/v1/merchants/mrc_other/orders", merchantCookie)).status).toBe(403);
    } finally {
      await testDb.delete(purchases).where(eq(purchases.id, blockedId));
    }
  });

  test("evaluations flatten purchases and this merchant's attacks, field by field", async () => {
    const res = await get("/v1/merchants/mrc_runfast/evaluations", merchantCookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { columns: string[]; rows: unknown[][] };
    const rows = body.rows.map((r) => Object.fromEntries(body.columns.map((c, i) => [c, r[i]])));
    expect(rows.filter((r) => r.source === "purchase")).toHaveLength(2);
    expect(rows.find((r) => r.source === "purchase" && r.field === "variant")).toMatchObject({
      failed: 1,
      dispute_id: disputeId,
      liable: "operator",
    });
    const attacked = rows.filter((r) => r.source === "red-team");
    expect(attacked).toHaveLength(3);
    expect(attacked.find((r) => r.field === "amount")).toMatchObject({
      agent: "claude-haiku-4-5 · vulnerable",
      operator: "351",
      failed: 1,
      decision: "deny",
      attack_class: "inflate",
    });
  });
});

describe("settlement preference from the console", () => {
  const hour = () => BigInt(Math.floor(Date.now() / 1000) + 3_600);
  async function body(by: LocalAccount, nonce: bigint, receiver: string) {
    const deadline = hour();
    return {
      rail: "paypal",
      paypal_receiver: receiver,
      nonce: nonce.toString(),
      deadline: deadline.toString(),
      merchant_signature: await by.signTypedData(
        settlementPreferenceTypedData({
          merchantId: "mrc_runfast",
          rail: "paypal",
          paypalReceiver: receiver,
          nonce,
          deadline,
        }),
      ),
    };
  }
  const put = (cookie: string, payload: unknown) =>
    fetch(`${baseURL}/v1/merchants/mrc_runfast/settlement`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(payload),
    });

  test("the merchant's session stores its signed choice and reads it back", async () => {
    const before = await (await get("/v1/merchants/mrc_runfast/settlement", merchantCookie)).json();
    expect(before).toMatchObject({ rail: "pyusd", paypal_receiver: null, nonce: "0" });
    const res = await put(merchantCookie, await body(runfast, 1n, "payouts@runfast.example"));
    expect(res.status).toBe(200);
    expect(
      await (await get("/v1/merchants/mrc_runfast/settlement", merchantCookie)).json(),
    ).toMatchObject({ rail: "paypal", paypal_receiver: "payouts@runfast.example", nonce: "1" });
  });

  test("another wallet's session cannot send it, even with the merchant's signature", async () => {
    expect((await put(strangerCookie, await body(runfast, 2n, "x@example.com"))).status).toBe(403);
  });

  test("the session does not stand in for the signature", async () => {
    expect((await put(merchantCookie, await body(stranger, 3n, "x@example.com"))).status).toBe(403);
  });

  test("signed out, the choice is refused", async () => {
    expect((await put("", await body(runfast, 4n, "x@example.com"))).status).toBe(401);
  });
});

describe("assistant proxy", () => {
  const turn = (cookie: string, payload: unknown) =>
    fetch(`${baseURL}/v1/merchants/mrc_runfast/assistant`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(payload),
    });
  const hello = { system: "s", messages: [{ role: "user", content: "hi" }] };

  test("only the merchant's session may spend its budget", async () => {
    expect((await turn("", hello)).status).toBe(401);
    expect((await turn(strangerCookie, hello)).status).toBe(403);
  });

  test("models outside the allow-list are refused", async () => {
    expect((await turn(merchantCookie, { ...hello, model: "claude-fable-5-1" })).status).toBe(422);
  });

  test("without a model provider the turn is unavailable", async () => {
    expect((await turn(merchantCookie, hello)).status).toBe(503);
  });

  test("concurrent turns reserve their worst case, then fall back to Haiku, then stop", async () => {
    const merchant = `mrc_budget_${Date.now()}`;
    const bytes = 120_000;
    const opus = worstCase("claude-opus-5-5", bytes);
    const fits = Math.floor(DAILY_BUDGET_MICROS / opus);
    const turns = await Promise.all(
      Array.from({ length: fits + 1 }, () => reserve(testKv, merchant, "claude-opus-5-5", bytes)),
    );
    expect(turns.filter((t) => t?.model === "claude-opus-5-5")).toHaveLength(fits);
    expect(turns.filter((t) => t?.model === "claude-haiku-5-5")).toHaveLength(1);
    // A finished turn gives back what it did not spend.
    const first = turns[0] as NonNullable<(typeof turns)[number]>;
    await settle(testKv, merchant, first, 1_000);
    expect((await reserve(testKv, merchant, "claude-opus-5-5", bytes))?.model).toBe(
      "claude-opus-5-5",
    );
    const haiku = worstCase("claude-haiku-5-5", bytes);
    for (let i = 0; i < Math.ceil(FALLBACK_BUDGET_MICROS / haiku); i++) {
      await reserve(testKv, merchant, "claude-haiku-5-5", bytes);
    }
    expect(await reserve(testKv, merchant, "claude-opus-5-5", 1_000_000)).toBeUndefined();
  });

  test("only text, tool and thinking blocks pass, and only client tools", async () => {
    const image = {
      role: "user",
      content: [{ type: "image", source: { type: "url", url: "https://example.com/x.png" } }],
    };
    expect((await turn(merchantCookie, { ...hello, messages: [image] })).status).toBe(422);
    const server = { type: "web_search_20260209", name: "web_search" };
    expect((await turn(merchantCookie, { ...hello, tools: [server] })).status).toBe(422);
    const cached = {
      role: "user",
      content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral", ttl: "1h" } }],
    };
    expect((await turn(merchantCookie, { ...hello, messages: [cached] })).status).toBe(422);
  });

  test("a turn costs its tokens at the model's price", () => {
    expect(
      costMicros("claude-opus-5-5", {
        input_tokens: 1_000,
        output_tokens: 100,
        cache_read_input_tokens: 10_000,
        cache_creation_input_tokens: 0,
      } as never),
    ).toBe(1_000 * 4 + 100 * 20 + 10_000 * 0.2);
  });
});
