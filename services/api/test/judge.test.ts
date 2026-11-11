import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { serve } from "@hono/node-server";
import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  alibis,
  disputes,
  eq,
  mandates,
  operators,
  purchases,
  redTeamCampaigns,
  session,
  user,
  verdicts,
} from "@keelson/db";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { pino } from "pino";
import { ulid } from "ulid";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth.ts";
import { admitJudgeCompile, JUDGE_COMPILES, JUDGE_TTL_MS, resetJudges } from "../src/judge.ts";
import { authenticate } from "../src/middleware/auth.ts";
import { JUDGE_LIMIT, reserve } from "../src/routes/merchant-assistant.ts";
import { testAuthEnv, testDb, testKv } from "./setup.ts";

const runfast = privateKeyToAccount(generatePrivateKey());
const secret = randomBytes(32).toString("base64url");
let app!: OpenAPIHono;
const server = serve({ fetch: (req) => app.fetch(req), port: 0, hostname: "127.0.0.1" });
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const auth = createAuth(testDb, testAuthEnv(baseURL, secret), { mrc_runfast: runfast.address });
const agentId = BigInt(Date.now());
app = createApp({
  db: testDb,
  kv: testKv,
  log: pino({ level: "silent" }),
  auth,
  appOrigin: baseURL,
  authenticate: authenticate(auth, baseURL),
  merchantSigners: { mrc_runfast: runfast.address },
  demoAgentId: agentId,
  rateLimit: { trustProxy: true },
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

const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

/** Opens a judge from its own address, as the app does. */
async function startJudge(
  ip = `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
) {
  return fetch(`${baseURL}/v1/judge/sessions`, {
    method: "POST",
    headers: {
      origin: baseURL,
      "idempotency-key": ulid(),
      // `<client>, <edge>, <render>`, as Render forwards it.
      "x-forwarded-for": `${ip}, 10.255.0.1, 10.255.0.2`,
    },
  });
}

const call = (path: string, cookie: string, init: RequestInit = {}) =>
  fetch(`${baseURL}${path}`, {
    ...init,
    headers: { origin: baseURL, cookie, ...(init.headers as Record<string, string>) },
  });

let judgeCookie = "";
let judgeId = "";
let shopperCookie = "";
let mandateId = "";
let capturedId = "";
let deniedId = "";
let disputeId = "";
let campaignId = "";

beforeAll(async () => {
  await testKv.del(`judge:opened:${new Date().toISOString().slice(0, 10)}`);
  const buyer = ulid();
  await testDb.insert(user).values({ id: buyer, name: "Buyer", email: `${buyer}@example.test` });
  await testDb.insert(operators).values({
    agentId,
    chainId: 421614,
    agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
    name: "op",
    cnfJwk: {},
  });
  mandateId = ulid();
  await testDb.insert(mandates).values({
    id: mandateId,
    userId: buyer,
    operatorAgentId: agentId,
    state: "ACTIVE",
    currency: "USD",
    maxMinor: 15_000n,
    remainingMinor: 1_100n,
    merchantIds: ["mrc_runfast"],
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  deniedId = ulid();
  await testDb.insert(purchases).values({
    id: deniedId,
    mandateId,
    merchantId: "mrc_runfast",
    currency: "USD",
    amountMinor: 47_900n,
    cartHash: randomBytes(32),
    state: "DENIED",
    logIndex: BigInt(Date.now()),
    evalTrace: {
      decision: "deny",
      fields: [
        { id: "amount", color: "green", pass: false },
        { id: "line_items", color: "green", pass: false },
        { id: "merchant", color: "green", pass: true },
      ],
    },
  });
  capturedId = ulid();
  await testDb.insert(purchases).values({
    id: capturedId,
    mandateId,
    merchantId: "mrc_runfast",
    currency: "USD",
    amountMinor: 13_900n,
    cartHash: randomBytes(32),
    state: "CAPTURED",
    countersignMode: "2of2",
    logIndex: BigInt(Date.now()) + 1n,
    anchoredSize: 758n,
    chainId: 421614,
    paypalCaptureId: `CAP${Date.now()}`,
    invoiceId: `INV${Date.now()}`,
    evalTrace: { decision: "allow", fields: [{ id: "amount", color: "green", pass: true }] },
  });
  await testDb
    .insert(alibis)
    .values({ purchaseId: capturedId, leafHash: randomBytes(32), bundle: {} });
  disputeId = `PP-D-${Date.now()}`;
  await testDb.insert(disputes).values({
    id: disputeId,
    purchaseId: capturedId,
    reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
    state: "RESOLVED",
    raw: {},
  });
  await testDb.insert(verdicts).values({
    id: ulid(),
    disputeId,
    liable: 2,
    ruleId: 60,
    amountMinor: 13_900n,
    currency: "USD",
    payee: runfast.address,
    digest: randomBytes(32),
    chainId: 421614,
    message: {},
    signatures: [],
    facts: {},
  });
  campaignId = ulid();
  await testDb.insert(redTeamCampaigns).values({
    id: campaignId,
    header: "{}",
    finishedAt: new Date(),
  });

  const res = await startJudge();
  expect(res.status).toBe(201);
  judgeId = ((await res.json()) as { user_id: string }).user_id;
  judgeCookie = cookieOf(res);

  const { test: utils } = await helpers.$context;
  const shopper = await utils.saveUser(utils.createUser());
  shopperCookie = (await utils.getAuthHeaders({ userId: shopper.id })).get("cookie") as string;
});

describe("judge sessions", () => {
  test("one click opens an anonymous judge with a session cookie", async () => {
    expect(judgeCookie).toContain("better-auth.session_token=");
    const [row] = await testDb.select().from(user).where(eq(user.id, judgeId));
    expect(row).toMatchObject({ isAnonymous: true, role: "user", emailVerified: false });
    expect(row?.email).toMatch(/@judge\.keelson\.finance$/);
  });

  test("the plugin's own anonymous sign-in is closed", async () => {
    const res = await fetch(`${baseURL}/api/auth/sign-in/anonymous`, {
      method: "POST",
      headers: { origin: baseURL, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  test("a signed-in session cannot open a judge", async () => {
    const res = await call("/v1/judge/sessions", judgeCookie, {
      method: "POST",
      headers: { "idempotency-key": ulid() },
    });
    expect(res.status).toBe(409);
  });

  test("only the app's origin can open a judge", async () => {
    const res = await fetch(`${baseURL}/v1/judge/sessions`, {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "idempotency-key": ulid(),
        "x-forwarded-for": "10.77.0.1, 10.255.0.1, 10.255.0.2",
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  test("addresses of one IPv6 /64 share the limit", async () => {
    const prefix = `2001:db8:${(Date.now() % 65_000).toString(16)}:1`;
    const statuses: number[] = [];
    for (let i = 1; i <= 6; i++)
      statuses.push((await startJudge(`${prefix}::${i.toString(16)}`)).status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(5);
    expect(statuses[5]).toBe(429);
  });

  test("a judge cannot link a PayPal account to its tenant", async () => {
    const res = await call("/api/auth/link-social", judgeCookie, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "paypal" }),
    });
    expect(res.status).toBe(403);
  });

  test("an expired judge is nobody, even with a live session", async () => {
    const res = await startJudge();
    const cookie = cookieOf(res);
    const id = ((await res.json()) as { user_id: string }).user_id;
    expect((await call("/v1/judge/tour", cookie)).status).toBe(200);
    await testDb
      .update(user)
      .set({ createdAt: new Date(Date.now() - JUDGE_TTL_MS - 1_000) })
      .where(eq(user.id, id));
    expect((await call("/v1/judge/tour", cookie)).status).toBe(401);
    expect((await call("/v1/merchants/me", cookie)).status).toBe(401);
  });

  test("five judges an hour per address", async () => {
    const statuses: number[] = [];
    const ip = `10.9.${Date.now() % 250}.9`;
    for (let i = 0; i < 6; i++) statuses.push((await startJudge(ip)).status);
    expect(statuses.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
    expect(statuses[5]).toBe(429);
  });
});

describe("tour", () => {
  test("shows the demo operator's real mandate, purchases, dispute and campaign", async () => {
    const res = await call("/v1/judge/tour", judgeCookie);
    expect(res.status).toBe(200);
    const tour = (await res.json()) as {
      merchant_id: string;
      agent_id: string;
      mandate: {
        id: string;
        purchases: {
          id: string;
          state: string;
          alibi_fragment: string | null;
          checks: { field: string; pass: boolean }[];
        }[];
      };
      dispute_id: string;
      campaign_id: string;
    };
    expect(tour).toMatchObject({
      merchant_id: "mrc_runfast",
      agent_id: agentId.toString(),
      dispute_id: disputeId,
      campaign_id: campaignId,
    });
    expect(tour.mandate.id).toBe(mandateId);
    const byId = Object.fromEntries(tour.mandate.purchases.map((p) => [p.id, p]));
    expect(byId[capturedId]).toMatchObject({ state: "CAPTURED", mode: "2of2" });
    expect(byId[capturedId]?.alibi_fragment).toMatch(/^[A-Za-z0-9_-]{43}\.758\.421614$/);
    expect(byId[deniedId]?.alibi_fragment).toBeNull();
    expect(byId[deniedId]?.state).toBe("DENIED");
    expect(byId[deniedId]?.checks.filter((c) => !c.pass).map((c) => c.field)).toEqual([
      "amount",
      "line_items",
    ]);
  });

  test("never shows a shopper's mandate, only Keelson's own test buyers'", async () => {
    const shopper = ulid();
    await testDb
      .insert(user)
      .values({ id: shopper, name: "Shopper", email: `${shopper}@shopper.invalid` });
    const theirs = ulid();
    await testDb.insert(mandates).values({
      id: theirs,
      userId: shopper,
      operatorAgentId: agentId,
      state: "ACTIVE",
      currency: "USD",
      maxMinor: 15_000n,
      remainingMinor: 1_100n,
      merchantIds: ["mrc_runfast"],
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const bought = ulid();
    await testDb.insert(purchases).values({
      id: bought,
      mandateId: theirs,
      merchantId: "mrc_runfast",
      currency: "USD",
      amountMinor: 13_900n,
      cartHash: randomBytes(32),
      state: "CAPTURED",
    });
    await testDb
      .insert(alibis)
      .values({ purchaseId: bought, leafHash: randomBytes(32), bundle: {} });
    const tour = (await (await call("/v1/judge/tour", judgeCookie)).json()) as {
      mandate: { id: string };
    };
    expect(tour.mandate.id).toBe(mandateId);
  });

  test("prefers the agent run, where a cart was blocked, over a newer plain purchase", async () => {
    const buyer = ulid();
    await testDb.insert(user).values({ id: buyer, name: "Buyer", email: `${buyer}@example.test` });
    const plain = ulid();
    await testDb.insert(mandates).values({
      id: plain,
      userId: buyer,
      operatorAgentId: agentId,
      state: "ACTIVE",
      currency: "USD",
      maxMinor: 100n,
      remainingMinor: 0n,
      merchantIds: ["mrc_runfast"],
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const bought = ulid();
    await testDb.insert(purchases).values({
      id: bought,
      mandateId: plain,
      merchantId: "mrc_runfast",
      currency: "USD",
      amountMinor: 100n,
      cartHash: randomBytes(32),
      state: "CAPTURED",
    });
    await testDb
      .insert(alibis)
      .values({ purchaseId: bought, leafHash: randomBytes(32), bundle: {} });
    const tour = (await (await call("/v1/judge/tour", judgeCookie)).json()) as {
      mandate: { id: string };
    };
    expect(tour.mandate.id).toBe(mandateId);
  });

  test("names the newest test buyer's purchase with a composed anonymous proof", async () => {
    const anonymous = (await (await call("/v1/judge/tour", judgeCookie)).json()) as {
      anonymous_purchase: { id: string; alibi_fragment: string | null } | null;
    };
    expect(anonymous.anonymous_purchase).toBeNull();
    const composed = { proof: "", public_inputs: [] };
    const shopper = ulid();
    await testDb
      .insert(user)
      .values({ id: shopper, name: "Shopper", email: `${shopper}@shopper.invalid` });
    const theirs = ulid();
    await testDb.insert(mandates).values({
      id: theirs,
      userId: shopper,
      operatorAgentId: agentId,
      state: "ACTIVE",
      currency: "USD",
      maxMinor: 100n,
      remainingMinor: 0n,
      merchantIds: ["mrc_runfast"],
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    for (const [id, mid] of [
      [capturedId, mandateId],
      [ulid(), theirs],
    ] as const) {
      if (id !== capturedId) {
        await testDb.insert(purchases).values({
          id,
          mandateId: mid,
          merchantId: "mrc_runfast",
          currency: "USD",
          amountMinor: 100n,
          cartHash: randomBytes(32),
          state: "CAPTURED",
        });
        await testDb
          .insert(alibis)
          .values({ purchaseId: id, leafHash: randomBytes(32), bundle: {} });
      }
      await testDb.update(purchases).set({ c1c3Proof: composed }).where(eq(purchases.id, id));
    }
    const tour = (await (await call("/v1/judge/tour", judgeCookie)).json()) as {
      anonymous_purchase: { id: string; alibi_fragment: string | null } | null;
    };
    expect(tour.anonymous_purchase?.id).toBe(capturedId);
    expect(tour.anonymous_purchase?.alibi_fragment).toMatch(/^[A-Za-z0-9_-]{43}\.758\.421614$/);
  });

  test("is for judges only", async () => {
    expect((await call("/v1/judge/tour", "")).status).toBe(401);
    expect((await call("/v1/judge/tour", shopperCookie)).status).toBe(403);
  });
});

describe("least privilege", () => {
  test("a judge reads the demo merchant's console, read only", async () => {
    const me = await call("/v1/merchants/me", judgeCookie);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ merchant_id: "mrc_runfast", read_only: true });
    for (const path of ["settlement", "disputes", "evaluations"]) {
      expect((await call(`/v1/merchants/mrc_runfast/${path}`, judgeCookie)).status).toBe(200);
    }
  });

  test("a judge cannot change the settlement or read another merchant", async () => {
    const put = await call("/v1/merchants/mrc_runfast/settlement", judgeCookie, {
      method: "PUT",
      headers: { "content-type": "application/json", "idempotency-key": ulid() },
      body: JSON.stringify({ rail: "pyusd", nonce: "9", deadline: "9999999999", signature: "0x" }),
    });
    expect(put.status).toBe(403);
    expect((await call("/v1/merchants/mrc_other/disputes", judgeCookie)).status).toBe(403);
  });

  test("a shopper is not let into the merchant console", async () => {
    expect((await call("/v1/merchants/me", shopperCookie)).status).toBe(403);
  });

  test("a judge's assistant budget is its own and admits one worst-case Opus turn", async () => {
    const owner = `judge:${ulid()}`;
    const first = await reserve(testKv, owner, "claude-opus-5-5", 3_000, JUDGE_LIMIT);
    expect(first?.model).toBe("claude-opus-5-5");
    const second = await reserve(testKv, owner, "claude-opus-5-5", 3_000, JUDGE_LIMIT);
    expect(second?.model).toBe("claude-haiku-5-5");
  });

  test("a judge compiles at most five mandates", async () => {
    const id = ulid();
    const admitted: boolean[] = [];
    for (let i = 0; i <= JUDGE_COMPILES; i++) admitted.push(await admitJudgeCompile(testKv, id));
    expect(admitted).toEqual([true, true, true, true, true, false]);
  });
});

describe("nightly reset", () => {
  test("closes stale judges, revokes what they left open, keeps fresh ones", async () => {
    const res = await startJudge();
    const stale = ((await res.json()) as { user_id: string }).user_id;
    const owner = (await (await startJudge()).json()) as { user_id: string };
    const old = new Date(Date.now() - JUDGE_TTL_MS - 60_000);
    await testDb.update(user).set({ createdAt: old }).where(eq(user.id, stale));
    await testDb.update(user).set({ createdAt: old }).where(eq(user.id, owner.user_id));
    const signed = ulid();
    await testDb.insert(mandates).values({
      id: signed,
      userId: owner.user_id,
      operatorAgentId: agentId,
      state: "SIGNED",
      currency: "USD",
      maxMinor: 1_000n,
      remainingMinor: 1_000n,
      merchantIds: ["mrc_runfast"],
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const r = await resetJudges({ db: testDb, kv: testKv, log: pino({ level: "silent" }) });
    expect(r.closed).toBeGreaterThanOrEqual(2);
    expect(await testDb.select().from(user).where(eq(user.id, stale))).toHaveLength(0);
    const [kept] = await testDb.select().from(user).where(eq(user.id, owner.user_id));
    expect(kept).toBeDefined();
    expect(
      await testDb.select().from(session).where(eq(session.userId, owner.user_id)),
    ).toHaveLength(0);
    const [m] = await testDb.select().from(mandates).where(eq(mandates.id, signed));
    expect(m?.state).toBe("REVOKED");
    // The fresh judge keeps its session.
    expect(await testDb.select().from(session).where(eq(session.userId, judgeId))).not.toHaveLength(
      0,
    );
  });
});

describe("invite", () => {
  const invite = randomBytes(32).toString("base64url");
  const lines: string[] = [];
  const invited = createApp({
    db: testDb,
    kv: testKv,
    log: pino({ level: "trace" }, { write: (line: string) => lines.push(line) }),
    auth,
    appOrigin: baseURL,
    authenticate: authenticate(auth, baseURL),
    demoAgentId: agentId,
    rateLimit: { trustProxy: true },
    judgeInvite: invite,
  });
  const today = () => new Date().toISOString().slice(0, 10);
  const open = (target: OpenAPIHono, body?: unknown) =>
    target.request("/v1/judge/sessions", {
      method: "POST",
      headers: {
        origin: baseURL,
        "idempotency-key": ulid(),
        "x-forwarded-for": `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}, 10.255.0.1, 10.255.0.2`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeAll(async () => {
    await testKv.set(`judge:opened:${today()}`, "200");
    await testKv.del(`judge:invited:${today()}`);
  });
  afterAll(async () => {
    await testKv.del([`judge:opened:${today()}`, `judge:invited:${today()}`]);
  });

  test("a valid invite opens a judge past the daily cap", async () => {
    const res = await open(invited, { invite });
    expect(res.status).toBe(201);
    expect(res.headers.getSetCookie().join()).toContain("better-auth.session_token=");
    expect(await testKv.get(`judge:invited:${today()}`)).toBe("1");
  });

  test("a wrong invite gets no bypass", async () => {
    const last = invite.endsWith("A") ? "B" : "A";
    for (const wrong of [`${invite.slice(0, -1)}${last}`, "", invite.slice(1)]) {
      expect((await open(invited, { invite: wrong })).status).toBe(429);
    }
    expect((await open(invited)).status).toBe(429);
  });

  test("without a configured invite, an invite changes nothing", async () => {
    expect((await open(app, { invite })).status).toBe(429);
    expect((await open(app)).status).toBe(429);
  });

  test("invited judges have a daily cap of their own", async () => {
    await testKv.set(`judge:invited:${today()}`, "300");
    expect((await open(invited, { invite })).status).toBe(429);
  });

  test("the invite is never logged", () => {
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(invite);
  });

  test("crossing 80% of the daily cap logs an error", async () => {
    lines.length = 0;
    await testKv.set(`judge:opened:${today()}`, "159");
    expect((await open(invited)).status).toBe(201);
    const alerts = lines.map((l) => JSON.parse(l)).filter((l) => l.msg === "judge cap 80% used");
    expect(alerts).toMatchObject([{ level: 50, used: 160, cap: 200 }]);
  });
});
