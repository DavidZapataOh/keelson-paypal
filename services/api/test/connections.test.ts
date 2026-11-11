import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { cartHash } from "@keelson/core";
import { agentConnections, eq, mandates, operators, purchases, user } from "@keelson/db";
import { buildSdPayload, parseMandate } from "@keelson/mandate";
import { pino } from "pino";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import demo from "../../../packages/mandate/test/fixtures/demo-mandate.json" with { type: "json" };
import { createApp } from "../src/app.ts";
import { normalizeUserCode } from "../src/connections.ts";
import { principalChannel } from "../src/principal.ts";
import { finishStops } from "../src/stop.ts";
import { tokenStopped } from "../src/stopped.ts";
import { createTee } from "../src/tee/config.ts";
import { EvidenceUploader } from "./evidence.ts";
import { testDb, testKv } from "./setup.ts";
import { carts, headerPrincipal } from "./tee-live.ts";

// Legs that record whatever reaches them: a revoked mandate must never get this far.
const legCalls: string[] = [];
const legs = createServer((req, res) => {
  legCalls.push(req.url ?? "");
  res.writeHead(503).end();
});
await new Promise<void>((resolve) => legs.listen(0, "127.0.0.1", resolve));
const legUrl = `http://127.0.0.1:${(legs.address() as AddressInfo).port}`;

const appOrigin = "https://app.keelson.finance";
const app = createApp({
  db: testDb,
  kv: testKv,
  log: pino({ level: "silent" }),
  authenticate: headerPrincipal,
  appOrigin,
  tee: createTee(
    {
      TEE_A_URL: legUrl,
      TEE_B_URL: legUrl,
      KEELSON_TEE_TOKEN: "unused",
      ARBITRUM_SEPOLIA_RPC_URL: "http://127.0.0.1:9",
    },
    { a: 500, b: 500 },
  ),
});

afterAll(async () => {
  await new Promise((resolve) => legs.close(resolve));
});

const REGISTRY = "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e";
const client = (subject: string, ...scopes: string[]) => ({
  "x-test-principal": JSON.stringify({ kind: "client", subject, scopes }),
});
const asUser = (subject: string) => ({
  "x-test-principal": JSON.stringify({ kind: "user", subject }),
});
const REASON =
  "I am Claude Code, buying the running shoes you asked for in this session. I compare prices at RunFast and check out only what you named.";
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

interface Operator {
  agentId: bigint;
  clientId: string;
}

async function newOperator(name = "Test operator"): Promise<Operator> {
  const agentId = BigInt(`0x${randomBytes(10).toString("hex")}`);
  const clientId = `agent-${ulid()}`;
  await testDb.insert(operators).values({
    agentId,
    chainId: 421614,
    agentRegistry: REGISTRY,
    name,
    cnfJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    clientId,
  });
  return { agentId, clientId };
}

async function newUser(): Promise<string> {
  const id = `user-${ulid()}`;
  await testDb.insert(user).values({ id, name: "Buyer", email: `${id}@example.test` });
  return id;
}

const send = (path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(path, {
    method: "POST",
    headers: {
      "idempotency-key": ulid(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const limits = (over: Record<string, unknown> = {}) => ({
  currency: "USD",
  perPurchaseMinor: 5_000,
  totalMinor: 10_000,
  merchants: ["mrc_runfast"],
  until: inDays(2),
  askAboveMinor: 2_500,
  ...over,
});

async function ask(op: Operator, over: Record<string, unknown> = {}) {
  const res = await send("/v1/connections", client(op.clientId, "countersign:write"), {
    name: "Claude Code",
    reason: REASON,
    limits: limits(over),
  });
  return { res, body: (await res.json()) as Record<string, string | number> };
}

const poll = (
  op: Operator,
  deviceCode: string,
  grant = "urn:ietf:params:oauth:grant-type:device_code",
) =>
  app.request("/v1/connections/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...client(op.clientId, "countersign:write"),
    },
    body: new URLSearchParams({ grant_type: grant, device_code: deviceCode }),
  });

async function pollError(op: Operator, deviceCode: string) {
  const res = await poll(op, deviceCode);
  expect(res.status).toBe(400);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return (await res.json()) as { error: string; interval?: number };
}

/** Lets the next poll through the interval, as if `interval` seconds had passed. */
const waitOut = (userCode: string) =>
  testDb
    .update(agentConnections)
    .set({ polledAt: new Date(Date.now() - 60_000) })
    .where(eq(agentConnections.userCode, userCode));

describe("an agent asks for a mandate (RFC 8628)", () => {
  test("only an agent's client with countersign:write, linked to an operator, may ask", async () => {
    const op = await newOperator();
    const body = { name: "Claude Code", reason: REASON, limits: limits() };
    expect((await send("/v1/connections", {}, body)).status).toBe(401);
    expect((await send("/v1/connections", client(op.clientId, "alibis:read"), body)).status).toBe(
      403,
    );
    const stray = await send("/v1/connections", client("unlinked", "countersign:write"), body);
    expect(stray.status).toBe(403);
    expect((await stray.json()).type).toMatch(/\/no-operator$/);
  });

  test("the answer is a device authorization: a short code, a link, 15 minutes, 5 seconds", async () => {
    const { res, body } = await ask(await newOperator());
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(body.device_code).toMatch(/^[\w-]{43}$/);
    expect(body.verification_uri).toBe(`${appOrigin}/connect`);
    expect(body.verification_uri_complete).toBe(`${appOrigin}/connect?c=${body.user_code}`);
    expect(body).toMatchObject({ expires_in: 900, interval: 5 });
    const [row] = await testDb
      .select()
      .from(agentConnections)
      .where(eq(agentConnections.userCode, body.user_code as string));
    // Only the hash of the device code is kept.
    expect(row?.deviceCodeHash.toString("base64url")).not.toBe(body.device_code);
  });

  test("a reason under 100 characters, limits that do not add up or a past date are refused", async () => {
    const op = await newOperator();
    const short = await send("/v1/connections", client(op.clientId, "countersign:write"), {
      name: "Claude Code",
      reason: "Buying shoes.",
      limits: limits(),
    });
    expect(short.status).toBe(422);
    expect((await ask(op, { perPurchaseMinor: 20_000 })).res.status).toBe(422);
    expect((await ask(op, { askAboveMinor: 9_000 })).res.status).toBe(422);
    expect((await ask(op, { merchants: ["mrc_elsewhere"] })).res.status).toBe(422);
    expect((await ask(op, { until: inDays(-1) })).res.status).toBe(422);
    expect((await ask(op, { until: inDays(31) })).res.status).toBe(422);
    const hidden = await send("/v1/connections", client(op.clientId, "countersign:write"), {
      name: "Claude‮Code",
      reason: REASON,
      limits: limits(),
    });
    expect(hidden.status).toBe(422);
  });

  test("polling says pending, slows a client that polls too fast, and is the asking client's only", async () => {
    const op = await newOperator();
    const { body } = await ask(op);
    const code = body.device_code as string;
    expect((await pollError(op, code)).error).toBe("authorization_pending");
    const fast = await pollError(op, code);
    expect(fast).toMatchObject({ error: "slow_down", interval: 10 });
    await waitOut(body.user_code as string);
    expect((await pollError(op, code)).error).toBe("authorization_pending");
    expect((await pollError(await newOperator(), code)).error).toBe("invalid_grant");
    expect((await pollError(op, "not-a-code")).error).toBe("invalid_grant");
    const wrongGrant = await poll(op, code, "client_credentials");
    expect((await wrongGrant.json()).error).toBe("unsupported_grant_type");
  });

  test("a denied request answers access_denied, and its code opens nothing after", async () => {
    const op = await newOperator();
    const sub = await newUser();
    const { body } = await ask(op);
    const userCode = body.user_code as string;
    const lower = userCode.toLowerCase().replace("-", " ");
    const read = await app.request(`/v1/connections/${encodeURIComponent(lower)}`, {
      headers: asUser(sub),
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      code: userCode,
      kind: "connect",
      state: "PENDING",
      name: "Claude Code",
      reason: REASON,
      agent: { agentId: op.agentId.toString(), operator: "Test operator" },
      limits: {
        currency: "USD",
        perPurchaseMinor: "5000",
        totalMinor: "10000",
        askAboveMinor: "2500",
        merchants: [{ id: "mrc_runfast", name: "RunFast" }],
      },
    });
    const denied = await send(`/v1/connections/${userCode}/deny`, asUser(sub));
    expect(denied.status).toBe(200);
    await waitOut(userCode);
    expect((await pollError(op, body.device_code as string)).error).toBe("access_denied");
    expect((await send(`/v1/connections/${userCode}/deny`, asUser(sub))).status).toBe(404);
    const draft = await send(`/v1/connections/${userCode}/draft`, asUser(sub), {
      limits: { perPurchaseMinor: 1, totalMinor: 1, merchants: ["mrc_runfast"], until: inDays(1) },
    });
    expect(draft.status).toBe(404);
  });

  test("an expired request answers expired_token and cannot be approved", async () => {
    const op = await newOperator();
    const { body } = await ask(op);
    await testDb
      .update(agentConnections)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(agentConnections.userCode, body.user_code as string));
    expect((await pollError(op, body.device_code as string)).error).toBe("expired_token");
    const read = await app.request(`/v1/connections/${body.user_code}`, {
      headers: asUser(await newUser()),
    });
    // Nobody opened it, so nobody but the agent learns what it asked.
    expect(read.status).toBe(404);
  });

  test("the approved mandate is answered once: the device code is spent with it", async () => {
    const op = await newOperator();
    const sub = await newUser();
    const { body } = await ask(op);
    const mid = await liveMandate(sub, op);
    await testDb
      .update(agentConnections)
      .set({ state: "APPROVED", userId: sub, mandateId: mid, decidedAt: new Date() })
      .where(eq(agentConnections.userCode, body.user_code as string));
    const res = await poll(op, body.device_code as string);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mandate_id: mid, kind: "connect" });
    expect((await pollError(op, body.device_code as string)).error).toBe("invalid_grant");
  });

  test("a user may lower what the agent asked, never raise it", async () => {
    const op = await newOperator();
    const sub = await newUser();
    const { body } = await ask(op);
    await send(`/v1/connections/${body.user_code}/match`, asUser(sub), {
      number: body.match_number,
    });
    const draft = (l: Record<string, unknown>) =>
      send(
        `/v1/connections/${body.user_code}/draft`,
        { ...asUser(sub), "keelson-device": "d" },
        {
          limits: {
            perPurchaseMinor: 5_000,
            totalMinor: 10_000,
            merchants: ["mrc_runfast"],
            until: inDays(1),
            askAboveMinor: 2_500,
            ...l,
          },
        },
      );
    for (const [l, field] of [
      [{ perPurchaseMinor: 5_001 }, "perPurchase"],
      [{ totalMinor: 10_001 }, "total"],
      [{ merchants: ["mrc_other"] }, "merchants"],
      [{ until: inDays(3) }, "until"],
      [{ askAboveMinor: 2_501 }, "askAbove"],
      [{ askAboveMinor: undefined }, "askAbove"],
    ] as const) {
      const res = await draft(l);
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ fields: [field] });
    }
    // Lower values pass the check and go on to the signing inputs, which this server lacks.
    expect((await draft({ perPurchaseMinor: 1_000, askAboveMinor: 500 })).status).toBe(409);
  });
});

/** An active mandate of `sub` naming the operator, held as a whole on a PayPal authorization. */
async function liveMandate(sub: string, op: Operator, state: "ACTIVE" | "SIGNED" = "ACTIVE") {
  const id = ulid();
  const m = parseMandate(structuredClone(demo));
  await testDb.insert(mandates).values({
    id,
    userId: sub,
    operatorAgentId: op.agentId,
    state,
    currency: "USD",
    maxMinor: 100_000n,
    remainingMinor: 100_000n,
    merchantIds: [carts.demo.cart.merchant],
    expiresAt: new Date(Date.now() + 86_400_000),
    openMandate: "open",
    mandateHash: randomBytes(32),
    holdMode: "mandate",
    paypalOrderId: `ORDER${randomBytes(6).toString("hex").toUpperCase()}`,
    paypalAuthorizationId: `AUTH${randomBytes(6).toString("hex").toUpperCase()}`,
    ...(await buildSdPayload(m, () => randomBytes(16))),
  });
  return id;
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const closed = (mid: string, requestId: string) =>
  [
    "e30.e30.sig",
    b64(["salt", "mandate", { v: "keelson.mandate.1", mid }]),
    `e30.${b64({ nonce: requestId })}.sig`,
  ].join("~");

describe("revoking where the money moves", { timeout: 120_000 }, () => {
  const countersign = async (op: Operator, mid: string, evidenceRoot = `0x${"ab".repeat(32)}`) => {
    const [row] = await testDb.select().from(mandates).where(eq(mandates.id, mid));
    return send("/v1/countersign", client(op.clientId, "countersign:write", "evidence:write"), {
      authorizationId: row?.paypalAuthorizationId,
      closedMandate: closed(mid, ulid()),
      cart: carts.demo.cart,
      unit: carts.demo.unit,
      evidenceRoot,
    });
  };

  test("disconnecting an agent stops its mandates of this user only, before any leg is asked", async () => {
    const op = await newOperator();
    const other = await newOperator("Other operator");
    const sub = await newUser();
    const someoneElse = await newUser();
    const mine = await liveMandate(sub, op);
    const signed = await liveMandate(sub, op, "SIGNED");
    const otherAgent = await liveMandate(sub, other);
    const otherUser = await liveMandate(someoneElse, op);
    const { body } = await ask(op);
    await testDb
      .update(agentConnections)
      .set({ state: "APPROVED", userId: sub, mandateId: mine, decidedAt: new Date() })
      .where(eq(agentConnections.userCode, body.user_code as string));

    expect((await send(`/v1/agents/${op.agentId}/disconnect`, asUser(someoneElse))).status).toBe(
      200,
    );
    // Disconnecting is the other user's own act; it stops only their mandate.
    const res = await send(`/v1/agents/${op.agentId}/disconnect`, asUser(sub));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: 2 });

    const state = async (id: string) =>
      (await testDb.select().from(mandates).where(eq(mandates.id, id)))[0];
    expect((await state(mine))?.revokeRequestedAt).not.toBeNull();
    expect((await state(signed))?.state).toBe("REVOKED");
    expect((await state(otherAgent))?.revokeRequestedAt).toBeNull();
    const [connection] = await testDb
      .select()
      .from(agentConnections)
      .where(eq(agentConnections.userCode, body.user_code as string));
    expect(connection?.disconnectedAt).not.toBeNull();

    legCalls.length = 0;
    const refused = await countersign(op, mine);
    expect(refused.status).toBe(409);
    expect((await refused.json()).type).toMatch(/\/mandate-not-active$/);
    expect(legCalls).toEqual([]);
    expect(otherUser).toBeDefined();
  });

  test("an agent of someone else cannot be disconnected by this user", async () => {
    const op = await newOperator();
    const res = await send(`/v1/agents/${op.agentId}/disconnect`, asUser(await newUser()));
    expect(res.status).toBe(404);
  });

  test("stopping all agents ends every live mandate, request and grant, and refuses countersigns", async () => {
    const sub = await newUser();
    const a = await liveMandate(sub, await newOperator());
    const opB = await newOperator();
    const b = await liveMandate(sub, opB);
    const { body } = await ask(opB);
    await testDb
      .update(agentConnections)
      .set({ userId: sub })
      .where(eq(agentConnections.userCode, body.user_code as string));
    const res = await send("/v1/agents/stop", asUser(sub));
    expect(res.status).toBe(200);
    const stopped = await res.json();
    expect(stopped).toMatchObject({
      revoked: 2,
      // No PayPal here: nothing is voided yet, so nothing is said to be released.
      released: [],
      releasing: [{ currency: "USD", minor: "200000" }],
      logIndexes: {},
      logged: false,
    });
    expect(stopped.mandateHashes).toHaveLength(2);
    for (const id of [a, b]) {
      const [row] = await testDb.select().from(mandates).where(eq(mandates.id, id));
      expect(row?.revokeRequestedAt).not.toBeNull();
    }
    const [asked] = await testDb
      .select()
      .from(agentConnections)
      .where(eq(agentConnections.userCode, body.user_code as string));
    expect(asked?.state).toBe("DENIED");

    legCalls.length = 0;
    const refused = await countersign(opB, b);
    expect(refused.status).toBe(409);
    expect(legCalls).toEqual([]);

    // Even a mandate the stop did not see, stored before it, cannot countersign.
    const missed = await liveMandate(sub, opB);
    await testDb
      .update(mandates)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(mandates.id, missed));
    const late = await countersign(opB, missed);
    expect(late.status).toBe(409);
    expect(legCalls).toEqual([]);
    // The resumer revokes it.
    await finishStops({ db: testDb, kv: testKv, log: pino({ level: "silent" }) });
    const [revoked] = await testDb.select().from(mandates).where(eq(mandates.id, missed));
    expect(revoked?.revokeRequestedAt).not.toBeNull();
    // Access tokens the user granted before the stop are refused; later ones are not.
    expect(await tokenStopped(testKv, sub, Math.floor(Date.now() / 1000) - 5)).toBe(true);
    expect(await tokenStopped(testKv, sub, Math.floor(Date.now() / 1000) + 5)).toBe(false);
    expect(await tokenStopped(testKv, await newUser(), 0)).toBe(false);

    const listed = await (await app.request("/v1/agents/stops", { headers: asUser(sub) })).json();
    expect(listed.stops[0]).toMatchObject({ id: stopped.id, revoked: 2 });
  });

  test("the agents list shows each agent's live mandate and what is left", async () => {
    const op = await newOperator("Shoe agent");
    const sub = await newUser();
    const mid = await liveMandate(sub, op);
    await testDb
      .update(mandates)
      .set({ remainingMinor: 1_194n, maxMinor: 5_000n })
      .where(eq(mandates.id, mid));
    const { body } = await ask(op);
    await testDb
      .update(agentConnections)
      .set({ state: "APPROVED", userId: sub, mandateId: mid, decidedAt: new Date() })
      .where(eq(agentConnections.userCode, body.user_code as string));
    const res = await app.request("/v1/agents", { headers: asUser(sub) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      agents: [
        {
          agentId: op.agentId.toString(),
          name: "Claude Code",
          operator: "Shoe agent",
          connected: true,
          mandate: { id: mid, maxMinor: "5000", remainingMinor: "1194" },
        },
      ],
    });
  });
});

describe("a cart above “ask me above” is paused for the user", { timeout: 120_000 }, () => {
  const evidence = new EvidenceUploader();
  beforeAll(async () => {
    await evidence.capture(carts.demo.cart);
  });
  afterAll(async () => {
    await evidence.close();
  });

  test("the agent gets a one-time request to poll and the user sees it on the agents channel", async () => {
    const op = await newOperator();
    const sub = await newUser();
    const mid = await liveMandate(sub, op);
    const { body } = await ask(op, {
      perPurchaseMinor: 50_000,
      totalMinor: 90_000,
      askAboveMinor: 5_000,
    });
    await testDb
      .update(agentConnections)
      .set({
        state: "APPROVED",
        userId: sub,
        mandateId: mid,
        decidedAt: new Date(),
        askAboveMinor: 5_000n,
      })
      .where(eq(agentConnections.userCode, body.user_code as string));
    const headers = client(op.clientId, "countersign:write", "evidence:write");
    const root = await evidence.upload(app, mid, carts.demo.cart, headers);
    const requestId = ulid();
    legCalls.length = 0;
    const res = await send("/v1/countersign", headers, {
      authorizationId: (await testDb.select().from(mandates).where(eq(mandates.id, mid)))[0]
        ?.paypalAuthorizationId,
      closedMandate: closed(mid, requestId),
      cart: carts.demo.cart,
      unit: carts.demo.unit,
      evidenceRoot: root,
    });
    expect(res.status).toBe(409);
    const paused = (await res.json()) as {
      type: string;
      approval: { device_code: string; user_code: string };
    };
    expect(paused.type).toMatch(/\/approval-required$/);
    expect(legCalls).toEqual([]);
    expect((await testDb.select().from(purchases).where(eq(purchases.id, requestId))).length).toBe(
      0,
    );

    const [once] = await testDb
      .select()
      .from(agentConnections)
      .where(eq(agentConnections.userCode, paused.approval.user_code));
    const total = carts.demo.cart.lines.reduce((s, l) => s + l.qty * l.unit_minor, 0);
    expect(once).toMatchObject({
      kind: "once",
      userId: sub,
      parentMandateId: mid,
      perPurchaseMinor: BigInt(total),
      totalMinor: BigInt(total),
      merchantIds: [carts.demo.cart.merchant],
    });
    expect(once?.cartHash?.equals(Buffer.from(cartHash(carts.demo.cart)))).toBe(true);

    const listed = await app.request("/v1/approvals", { headers: asUser(sub) });
    expect(await listed.json()).toMatchObject({
      approvals: [{ code: paused.approval.user_code, name: "Claude Code", mandateId: mid }],
    });
    const channel = principalChannel({ kind: "user", subject: sub }, "agents");
    const events = await testDb.query.events.findMany({
      where: (e, { eq: is }) => is(e.channel, channel),
    });
    expect(events.map((e) => (e.payload as { type: string }).type)).toContain("approval.requested");

    // Asking again for the same cart does not ask the user twice.
    const again = await send("/v1/countersign", headers, {
      authorizationId: (await testDb.select().from(mandates).where(eq(mandates.id, mid)))[0]
        ?.paypalAuthorizationId,
      closedMandate: closed(mid, ulid()),
      cart: carts.demo.cart,
      unit: carts.demo.unit,
      evidenceRoot: root,
    });
    const second = (await again.json()) as { approval: Record<string, unknown> };
    expect(second.approval.user_code).toBe(paused.approval.user_code);
    expect(second.approval.device_code).toBeUndefined();

    // Only the mandate's user sees the one-time request.
    const stranger = await app.request(`/v1/connections/${paused.approval.user_code}`, {
      headers: asUser(await newUser()),
    });
    expect(stranger.status).toBe(404);
    const mineToo = await app.request(`/v1/connections/${paused.approval.user_code}`, {
      headers: asUser(sub),
    });
    expect(await mineToo.json()).toMatchObject({
      kind: "once",
      parent: { mandateId: mid },
    });

    // Revoking the mandate withdraws the question: it can no longer be approved.
    await send(`/v1/agents/${op.agentId}/disconnect`, asUser(sub));
    const after = await app.request(`/v1/connections/${paused.approval.user_code}`, {
      headers: asUser(sub),
    });
    expect((await after.json()).state).toBe("DENIED");
  });

  test("a mandate approved for one cart countersigns that cart only", async () => {
    const op = await newOperator();
    const sub = await newUser();
    const parent = await liveMandate(sub, op);
    const mid = await liveMandate(sub, op);
    const headers = client(op.clientId, "countersign:write", "evidence:write");
    const { body } = await ask(op);
    await testDb
      .update(agentConnections)
      .set({
        kind: "once",
        parentMandateId: parent,
        cartHash: randomBytes(32),
        state: "APPROVED",
        userId: sub,
        mandateId: mid,
        askAboveMinor: null,
        decidedAt: new Date(),
      })
      .where(eq(agentConnections.userCode, body.user_code as string));
    const root = await evidence.upload(app, mid, carts.demo.cart, headers);
    legCalls.length = 0;
    const res = await send("/v1/countersign", headers, {
      authorizationId: (await testDb.select().from(mandates).where(eq(mandates.id, mid)))[0]
        ?.paypalAuthorizationId,
      closedMandate: closed(mid, ulid()),
      cart: carts.demo.cart,
      unit: carts.demo.unit,
      evidenceRoot: root,
    });
    expect(res.status).toBe(422);
    expect((await res.json()).type).toMatch(/\/not-the-approved-cart$/);
    expect(legCalls).toEqual([]);
  });
});

test("a client linked to several operators cannot ask: the mandate would name one at random", async () => {
  const op = await newOperator();
  await testDb.insert(operators).values({
    agentId: op.agentId + 1n,
    chainId: 421614,
    agentRegistry: REGISTRY,
    name: "Twin",
    cnfJwk: {},
    clientId: op.clientId,
  });
  const { res, body } = await ask(op);
  expect(res.status).toBe(409);
  expect(body.type).toMatch(/\/several-operators$/);
});

test("guessing user codes is budgeted across reads, denials and drafts", async () => {
  const sub = await newUser();
  const statuses: number[] = [];
  for (let i = 0; i < 22; i++) {
    const res =
      i % 2 === 0
        ? await app.request(`/v1/connections/BCDF-${"GHJK"}`, { headers: asUser(sub) })
        : await send("/v1/connections/BCDF-GHJK/deny", asUser(sub));
    statuses.push(res.status);
  }
  expect(statuses.slice(0, 20).every((s) => s === 404)).toBe(true);
  expect(statuses.slice(20)).toEqual([429, 429]);
});

test("user codes are read forgivingly and only from the RFC 8628 alphabet", () => {
  expect(normalizeUserCode("bcdf ghjk")).toBe("BCDF-GHJK");
  expect(normalizeUserCode("BCDF-GHJK")).toBe("BCDF-GHJK");
  expect(normalizeUserCode("ABCD-EFGH")).toBeUndefined();
  expect(normalizeUserCode("BCDF-GHJ")).toBeUndefined();
});
