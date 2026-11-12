import { randomBytes } from "node:crypto";
import { agentConnections, eq, mandates, operators, user } from "@keelson/db";
import { buildSdPayload, parseMandate } from "@keelson/mandate";
import { pino } from "pino";
import { ulid } from "ulid";
import { describe, expect, test } from "vitest";
import demo from "../../../packages/mandate/test/fixtures/demo-mandate.json" with { type: "json" };
import { createApp } from "../src/app.ts";
import { matchOptions } from "../src/connections.ts";
import { testDb, testKv } from "./setup.ts";
import { carts, headerPrincipal } from "./tee-live.ts";

const appOrigin = "https://app.keelson.finance";
const app = createApp({
  db: testDb,
  kv: testKv,
  log: pino({ level: "silent" }),
  authenticate: headerPrincipal,
  appOrigin,
});

const REGISTRY = "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e";
const REASON =
  "I am Claude Code, buying the running shoes you asked for in this session. I compare prices at RunFast and check out only what you named.";
const client = (subject: string) => ({
  "x-test-principal": JSON.stringify({
    kind: "client",
    subject,
    scopes: ["countersign:write"],
  }),
});
const asUser = (subject: string) => ({
  "x-test-principal": JSON.stringify({ kind: "user", subject }),
});
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

interface Operator {
  agentId: bigint;
  clientId: string;
}

async function newOperator(): Promise<Operator> {
  const agentId = BigInt(`0x${randomBytes(10).toString("hex")}`);
  const clientId = `agent-${ulid()}`;
  await testDb.insert(operators).values({
    agentId,
    chainId: 421614,
    agentRegistry: REGISTRY,
    name: "Test operator",
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

async function ask(op: Operator) {
  const res = await send("/v1/connections", client(op.clientId), {
    name: "Claude Code",
    reason: REASON,
    limits: {
      currency: "USD",
      perPurchaseMinor: 5_000,
      totalMinor: 10_000,
      merchants: ["mrc_runfast"],
      until: inDays(2),
    },
  });
  expect(res.status).toBe(201);
  return (await res.json()) as {
    device_code: string;
    user_code: string;
    request_id: string;
    match_number: number;
  };
}

const read = (op: Operator, id: string) =>
  app.request(`/v1/connections/requests/${id}`, { headers: client(op.clientId) });

const draft = (code: string, sub: string) =>
  send(
    `/v1/connections/${code}/draft`,
    { ...asUser(sub), "keelson-device": "d" },
    {
      limits: {
        perPurchaseMinor: 5_000,
        totalMinor: 10_000,
        merchants: ["mrc_runfast"],
        until: inDays(1),
      },
    },
  );

/** An active mandate of `sub` naming the operator, signed from the demo fixture. */
async function liveMandate(
  sub: string,
  op: Operator,
  over: Partial<typeof mandates.$inferInsert> = {},
) {
  const id = ulid();
  await testDb.insert(mandates).values({
    id,
    userId: sub,
    operatorAgentId: op.agentId,
    state: "ACTIVE",
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
    ...(await buildSdPayload(parseMandate(structuredClone(demo)), () => randomBytes(16))),
    ...over,
  });
  return id;
}

describe("number matching on the device link", () => {
  test("the agent gets a two-digit number, and the page offers it among three", async () => {
    const op = await newOperator();
    const asked = await ask(op);
    expect(asked.match_number).toBeGreaterThanOrEqual(10);
    expect(asked.match_number).toBeLessThanOrEqual(99);
    const sub = await newUser();
    const view = await (
      await app.request(`/v1/connections/${asked.user_code}`, { headers: asUser(sub) })
    ).json();
    expect(view.match.matched).toBe(false);
    expect(view.match.options).toHaveLength(3);
    expect(view.match.options).toContain(asked.match_number);
    expect(view.match.options).toEqual(
      [...view.match.options].sort((a: number, b: number) => a - b),
    );
    // The same three on every read: reloading tells nothing.
    expect(matchOptions(asked.request_id, asked.match_number)).toEqual(view.match.options);
  });

  test("nothing is drafted before the number is picked", async () => {
    const op = await newOperator();
    const asked = await ask(op);
    const res = await draft(asked.user_code, await newUser());
    expect(res.status).toBe(409);
    expect((await res.json()).type).toMatch(/\/number-not-matched$/);
  });

  test("a wrong number denies the request, and the agent hears no", async () => {
    const op = await newOperator();
    const asked = await ask(op);
    const sub = await newUser();
    const wrong = asked.match_number === 99 ? 98 : asked.match_number + 1;
    const res = await send(`/v1/connections/${asked.user_code}/match`, asUser(sub), {
      number: wrong,
    });
    expect(res.status).toBe(409);
    expect((await res.json()).type).toMatch(/\/number-mismatch$/);
    const state = await (await read(op, asked.request_id)).json();
    expect(state.state).toBe("DENIED");
  });

  test("the right number opens the request to this user only", async () => {
    const op = await newOperator();
    const asked = await ask(op);
    const sub = await newUser();
    const res = await send(`/v1/connections/${asked.user_code}/match`, asUser(sub), {
      number: asked.match_number,
    });
    expect(res.status).toBe(200);
    // Past the match, the draft goes on to the signing inputs, which this server lacks.
    const drafted = await draft(asked.user_code, sub);
    expect((await drafted.json()).type).not.toMatch(/number-not-matched/);
    const stranger = await app.request(`/v1/connections/${asked.user_code}`, {
      headers: asUser(await newUser()),
    });
    expect(stranger.status).toBe(404);
  });
});

describe("reading a request without spending the device code", () => {
  test("the asking client reads its state as often as it likes; no other client can", async () => {
    const op = await newOperator();
    const asked = await ask(op);
    for (let i = 0; i < 3; i++) {
      const res = await read(op, asked.request_id);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id: asked.request_id,
        kind: "connect",
        state: "PENDING",
        mandateId: null,
        userCode: asked.user_code,
        approvalUrl: `${appOrigin}/connect?c=${asked.user_code}`,
        matchNumber: asked.match_number,
        interval: 5,
        operatorAgentId: op.agentId.toString(),
      });
    }
    expect((await read(await newOperator(), asked.request_id)).status).toBe(404);
    // The device code still answers RFC 8628 polls.
    const poll = await app.request("/v1/connections/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...client(op.clientId) },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: asked.device_code,
      }),
    });
    expect((await poll.json()).error).toBe("authorization_pending");
  });

  test("an expired request reads as expired", async () => {
    const op = await newOperator();
    const asked = await ask(op);
    await testDb
      .update(agentConnections)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(agentConnections.id, asked.request_id));
    expect((await (await read(op, asked.request_id)).json()).state).toBe("EXPIRED");
  });
});

describe("an agent asks to change its mandate", () => {
  test("the user is asked with the agent's note, under the mandate, needing no number", async () => {
    const op = await newOperator();
    const sub = await newUser();
    const mid = await liveMandate(sub, op);
    const res = await send(`/v1/mandates/${mid}/changes`, client(op.clientId), {
      note: "Needs $40 more for shipping",
      limits: { totalMinor: 140_000, perPurchaseMinor: 140_000, until: inDays(2) },
    });
    expect(res.status).toBe(201);
    const asked = (await res.json()) as Record<string, string>;
    expect(asked.device_code).toBeUndefined();
    const state = await (await read(op, asked.request_id as string)).json();
    expect(state).toMatchObject({
      kind: "change",
      state: "PENDING",
      parentMandateId: mid,
      matchNumber: null,
    });
    const view = await (
      await app.request(`/v1/connections/${asked.user_code}`, { headers: asUser(sub) })
    ).json();
    expect(view).toMatchObject({
      kind: "change",
      reason: "Needs $40 more for shipping",
      parent: { mandateId: mid, totalMinor: "100000", remainingMinor: "100000" },
      match: null,
      limits: { totalMinor: "140000", perPurchaseMinor: "140000" },
    });
    // Only the mandate's user sees it.
    const stranger = await app.request(`/v1/connections/${asked.user_code}`, {
      headers: asUser(await newUser()),
    });
    expect(stranger.status).toBe(404);

    const again = await send(`/v1/mandates/${mid}/changes`, client(op.clientId), {
      note: "Needs $40 more for shipping",
      limits: { until: inDays(2) },
    });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ requestId: asked.request_id });
  });

  test("left out, the total asked is what is left of the mandate, not its total again", async () => {
    const op = await newOperator();
    const sub = await newUser();
    const mid = await liveMandate(sub, op, { remainingMinor: 5_000n });
    const res = await send(`/v1/mandates/${mid}/changes`, client(op.clientId), {
      note: "Needs a few more days to compare prices",
      limits: { until: inDays(3) },
    });
    const asked = (await res.json()) as { user_code: string };
    const view = await (
      await app.request(`/v1/connections/${asked.user_code}`, { headers: asUser(sub) })
    ).json();
    expect(view.limits.totalMinor).toBe("5000");
    expect(BigInt(view.limits.perPurchaseMinor)).toBeLessThanOrEqual(5_000n);
  });

  test("only the operator's client may ask, and only for a live mandate", async () => {
    const op = await newOperator();
    const sub = await newUser();
    const mid = await liveMandate(sub, op);
    const other = await newOperator();
    const note = { note: "Needs $40 more for shipping", limits: { until: inDays(2) } };
    expect((await send(`/v1/mandates/${mid}/changes`, client(other.clientId), note)).status).toBe(
      404,
    );
    const bad = await send(`/v1/mandates/${mid}/changes`, client(op.clientId), {
      ...note,
      limits: { perPurchaseMinor: 200_000, totalMinor: 100_000, until: inDays(2) },
    });
    expect(bad.status).toBe(422);
    const ended = await liveMandate(sub, op, { revokeRequestedAt: new Date() });
    expect((await send(`/v1/mandates/${ended}/changes`, client(op.clientId), note)).status).toBe(
      409,
    );
  });
});

describe("checking a cart before the countersign", () => {
  const check = (op: Operator, mid: string, cart: unknown) =>
    send(`/v1/mandates/${mid}/check`, client(op.clientId), { cart });

  test("every mandate field comes back with both sides, from the legs' policy set", async () => {
    const op = await newOperator();
    const sub = await newUser();
    const mid = await liveMandate(sub, op);
    const res = await check(op, mid, carts.demo.cart);
    expect(res.status).toBe(200);
    const body = await res.json();
    const fields = body.checks.map((c: { field: string }) => c.field);
    expect(fields).toEqual(expect.arrayContaining(["total", "budget", "merchant"]));
    expect(body.canAttempt).toBe(body.blockers.length === 0);
  });

  test("a cart above the mandate is blocked on total, with what to do next", async () => {
    const op = await newOperator();
    const sub = await newUser();
    const mid = await liveMandate(sub, op);
    const big = {
      ...carts.demo.cart,
      lines: carts.demo.cart.lines.map((l) => ({ ...l, unit_minor: 9_000_000 })),
    };
    const body = await (await check(op, mid, big)).json();
    expect(body.canAttempt).toBe(false);
    const total = body.blockers.find((b: { code: string }) => b.code === "field:total");
    expect(total?.next).toMatch(/one-time approval|request_mandate_change/);
  });

  test("a revoked mandate cannot be attempted; another operator's is not found", async () => {
    const op = await newOperator();
    const sub = await newUser();
    const ended = await liveMandate(sub, op, { revokeRequestedAt: new Date() });
    const body = await (await check(op, ended, carts.demo.cart)).json();
    expect(body.blockers[0]).toMatchObject({ code: "mandate-not-active" });
    expect((await check(await newOperator(), ended, carts.demo.cart)).status).toBe(404);
  });
});

describe("OpenID AuthZEN evaluations over the cart check", () => {
  const evaluation = (op: Operator, mid: string, cart: unknown) => ({
    subject: { type: "agent", id: op.agentId.toString() },
    action: { name: "purchase" },
    resource: { type: "mandate", id: mid, properties: { cart } },
  });
  const big = {
    ...carts.demo.cart,
    lines: carts.demo.cart.lines.map((l) => ({ ...l, unit_minor: 9_000_000 })),
  };
  const checkOf = async (op: Operator, mid: string, cart: unknown) =>
    (await send(`/v1/mandates/${mid}/check`, client(op.clientId), { cart })).json();

  test("the PDP publishes its endpoints", async () => {
    const res = await app.request("/.well-known/authzen-configuration");
    expect(await res.json()).toEqual({
      policy_decision_point: "https://api.keelson.finance",
      access_evaluation_endpoint: "https://api.keelson.finance/access/v1/evaluation",
      access_evaluations_endpoint: "https://api.keelson.finance/access/v1/evaluations",
    });
  });

  test("the decision is the cart check's, never binding, with the failed fields", async () => {
    const op = await newOperator();
    const mid = await liveMandate(await newUser(), op);
    const check = await checkOf(op, mid, big);
    const res = await send("/access/v1/evaluation", client(op.clientId), evaluation(op, mid, big));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decision).toBe(false);
    expect(body.context.binding).toBe(false);
    expect(body.context.checks).toEqual(check.checks);
    expect(body.context.blockers.map((b: { code: string }) => b.code)).toContain("field:total");
    expect(body.context.reason_admin.en).toContain("total");
    const fits = await checkOf(op, mid, carts.demo.cart);
    const ok = await send(
      "/access/v1/evaluation",
      client(op.clientId),
      evaluation(op, mid, carts.demo.cart),
    );
    expect((await ok.json()).decision).toBe(fits.canAttempt);
  });

  test("another client's mandate, or another agent, is denied without saying why it exists", async () => {
    const op = await newOperator();
    const mid = await liveMandate(await newUser(), op);
    const other = await newOperator();
    const theirs = await send(
      "/access/v1/evaluation",
      client(other.clientId),
      evaluation(other, mid, carts.demo.cart),
    );
    expect(await theirs.json()).toMatchObject({
      decision: false,
      context: { reason_admin: { en: "No such mandate for this client." } },
    });
    const wrongAgent = await send("/access/v1/evaluation", client(op.clientId), {
      ...evaluation(op, mid, carts.demo.cart),
      subject: { type: "agent", id: other.agentId.toString() },
    });
    expect((await wrongAgent.json()).decision).toBe(false);
  });

  test("a boxcar answers each evaluation in order, filling what it omits from the defaults", async () => {
    const op = await newOperator();
    const mid = await liveMandate(await newUser(), op);
    const base = evaluation(op, mid, carts.demo.cart);
    const res = await send("/access/v1/evaluations", client(op.clientId), {
      subject: base.subject,
      action: base.action,
      evaluations: [
        { resource: base.resource },
        { resource: { ...base.resource, properties: { cart: big } } },
      ],
    });
    const { evaluations } = await res.json();
    expect(evaluations).toHaveLength(2);
    expect(evaluations[1].decision).toBe(false);
    expect(evaluations[1].context.blockers.map((b: { code: string }) => b.code)).toContain(
      "field:total",
    );
  });
});
