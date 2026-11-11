import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type Cart, cartHash, toHex } from "@keelson/core";
import {
  agentConnections,
  eq,
  mandates,
  oauthClient,
  oauthConsent,
  operators,
  purchases,
  teeSigners,
  user,
} from "@keelson/db";
import { buildManifest, canonicalBytes, MEDIA_TYPES, type SealedItem } from "@keelson/evidence";
import {
  buildSdPayload,
  ClosedMandateError,
  parseMandate,
  verifyKeyBinding,
} from "@keelson/mandate";
import { pino } from "pino";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import demo from "../../../packages/mandate/test/fixtures/demo-mandate.json" with { type: "json" };
import { createApp } from "../src/app.ts";
import { tokenScopes } from "../src/auth.ts";
import { hostedCapError, knownHost } from "../src/hosted-caps.ts";
import { tokenStopped } from "../src/stopped.ts";
import { createTee } from "../src/tee/config.ts";
import { testDb, testKv } from "./setup.ts";
import { carts, headerPrincipal } from "./tee-live.ts";

const REGISTRY = "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e";
const REASON =
  "I am Claude, buying the running shoes you asked for in this chat. I compare prices at RunFast and check out only what you named.";
const DELEGATED = ["alibis:read", "mandates:request", "evidence:write", "purchases:write"];
const { cart, unit } = carts.demo;
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

/** An app (`azp`) acting for `user` (`sub`) with a token the user granted it. */
const asHost = (client: string, sub: string, scopes = DELEGATED) => ({
  "x-test-principal": JSON.stringify({ kind: "client", subject: client, user: sub, scopes }),
});
const asOperator = (client: string) => ({
  "x-test-principal": JSON.stringify({
    kind: "client",
    subject: client,
    scopes: ["countersign:write", "evidence:write"],
  }),
});
const asUser = (sub: string) => ({
  "x-test-principal": JSON.stringify({ kind: "user", subject: sub }),
});

// Keelson's hosted operator: its client is Keelson's own, its `cnf` key the one the API closes with.
const HOSTED = BigInt(`0x${randomBytes(7).toString("hex")}`);
const KEELSON_CLIENT = `keelson-${ulid()}`;
const hostedPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);
const hostedJwk = await crypto.subtle.exportKey("jwk", hostedPair.publicKey);
const hostedCnf = { kty: "EC", crv: "P-256", x: hostedJwk.x as string, y: hostedJwk.y as string };

// Leg A, reached over HTTP like the real one; it records what it is asked and is down.
const legA: { body?: Record<string, unknown> | undefined } = {};
const leg = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    if (req.url === "/v1/countersign") legA.body = JSON.parse(raw);
    res.writeHead(503).end();
  });
});
await new Promise<void>((resolve) => leg.listen(0, "127.0.0.1", resolve));
const legUrl = `http://127.0.0.1:${(leg.address() as AddressInfo).port}`;
const tee = createTee(
  {
    TEE_A_URL: legUrl,
    TEE_B_URL: legUrl,
    KEELSON_TEE_TOKEN: "unused",
    ARBITRUM_SEPOLIA_RPC_URL: "http://127.0.0.1:9",
  },
  { a: 2_000, b: 500 },
);

const app = createApp({
  db: testDb,
  kv: testKv,
  log: pino({ level: "silent" }),
  authenticate: headerPrincipal,
  appOrigin: "https://app.keelson.finance",
  demoAgentId: HOSTED,
  hostedAgentKey: hostedPair.privateKey,
  tee,
});

beforeAll(async () => {
  await testDb.insert(operators).values({
    agentId: HOSTED,
    chainId: 421614,
    agentRegistry: REGISTRY,
    name: "Keelson",
    cnfJwk: hostedCnf,
    clientId: KEELSON_CLIENT,
  });
  await testDb
    .insert(teeSigners)
    .values({
      address: randomBytes(20),
      teeKind: 1,
      measurement: "test",
      binding: {},
      attestation: {},
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .onConflictDoNothing();
});
afterAll(async () => {
  await new Promise((resolve) => leg.close(resolve));
});

async function newUser(): Promise<string> {
  const id = `user-${ulid()}`;
  await testDb.insert(user).values({ id, name: "Buyer", email: `${id}@example.test` });
  return id;
}
const newHost = () => `host-${ulid()}`;

async function newOperator(clientId: string): Promise<bigint> {
  const agentId = BigInt(`0x${randomBytes(7).toString("hex")}`);
  await testDb.insert(operators).values({
    agentId,
    chainId: 421614,
    agentRegistry: REGISTRY,
    name: "Own operator",
    cnfJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    clientId,
  });
  return agentId;
}

/** A well-formed open mandate: the API closes it, and only the legs would verify it. */
const OPEN = `${b64({ alg: "ES256" })}.${b64({})}.c2ln~~${b64({ alg: "ES256", typ: "kb" })}.${b64({ _sd_alg: "sha-256" })}.c2ln~`;

/**
 * An active mandate of `sub` held as a whole, naming `operator`, that `sub` approved for `client`:
 * the `agent_connections` row the approval page leaves.
 */
async function approved(sub: string, client: string, operator = HOSTED, amount = 100_000n) {
  const id = ulid();
  const authorizationId = `AUTH${randomBytes(6).toString("hex").toUpperCase()}`;
  await testDb.insert(mandates).values({
    id,
    userId: sub,
    operatorAgentId: operator,
    state: "ACTIVE",
    currency: "USD",
    maxMinor: amount,
    remainingMinor: amount,
    merchantIds: [cart.merchant],
    expiresAt: new Date(Date.now() + 86_400_000),
    openMandate: OPEN,
    mandateHash: randomBytes(32),
    holdMode: "mandate",
    paypalOrderId: `ORDER${randomBytes(6).toString("hex").toUpperCase()}`,
    paypalAuthorizationId: authorizationId,
    ...(await buildSdPayload(parseMandate(structuredClone(demo)), () => randomBytes(16))),
  });
  await testDb.insert(agentConnections).values({
    id: ulid(),
    kind: "connect",
    clientId: client,
    operatorAgentId: operator,
    name: "Claude",
    reason: REASON,
    userCode: `${randomBytes(4).toString("hex").toUpperCase()}`,
    deviceCodeHash: randomBytes(32),
    currency: "USD",
    perPurchaseMinor: 50_000n,
    totalMinor: 100_000n,
    merchantIds: [cart.merchant],
    notAfter: new Date(Date.now() + 86_400_000),
    expiresAt: new Date(Date.now() + 900_000),
    userId: sub,
    state: "APPROVED",
    mandateId: id,
    decidedAt: new Date(),
  });
  return { id, authorizationId };
}

const send = (path: string, headers: Record<string, string>, body?: unknown, method = "POST") =>
  app.request(path, {
    method,
    headers: {
      "idempotency-key": ulid(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const askBody = {
  name: "Claude",
  reason: REASON,
  limits: {
    currency: "USD",
    perPurchaseMinor: 5_000,
    totalMinor: 10_000,
    merchants: ["mrc_runfast"],
    until: inDays(2),
  },
};

/** What `keelson.submit_evidence` uploads: the store's product and cart, and the agent's reading. */
async function evidence(headers: Record<string, string>, mandateId: string, of: Cart = cart) {
  const salt = () => crypto.getRandomValues(new Uint8Array(32));
  const items: SealedItem[] = [
    {
      type: "api.product",
      mediaType: MEDIA_TYPES["api.product"],
      bytes: canonicalBytes({ sku: of.lines[0]?.sku }),
      salt: salt(),
    },
    {
      type: "api.cart",
      mediaType: MEDIA_TYPES["api.cart"],
      bytes: canonicalBytes(of),
      salt: salt(),
    },
    {
      type: "llm.observation",
      mediaType: MEDIA_TYPES["llm.observation"],
      bytes: new TextEncoder().encode("The shoes, size 10, in stock."),
      salt: salt(),
    },
  ];
  return send("/v1/evidence", headers, {
    mandateId,
    manifest: buildManifest(items),
    items: items.map((i) => ({
      type: i.type,
      mediaType: i.mediaType,
      salt: Buffer.from(i.salt).toString("base64"),
      bytes: Buffer.from(i.bytes).toString("base64"),
    })),
  });
}

async function sealed(headers: Record<string, string>, mandateId: string): Promise<string> {
  const res = await evidence(headers, mandateId);
  expect(res.status).toBe(201);
  return ((await res.json()) as { evidenceRoot: string }).evidenceRoot;
}

const countersign = (
  headers: Record<string, string>,
  m: { id: string; authorizationId: string },
  evidenceRoot: string,
  extra: Record<string, unknown> = {},
) =>
  send("/v1/countersign", headers, {
    authorizationId: m.authorizationId,
    mandateId: m.id,
    cart,
    unit,
    evidenceRoot,
    ...extra,
  });

const purchasesOf = (mandateId: string) =>
  testDb.select().from(purchases).where(eq(purchases.mandateId, mandateId));

describe("an app acting for a user asks that user only", () => {
  test("for a mandate through Keelson's hosted operator, bound to the user, with no number to match", async () => {
    const a = await newUser();
    const host = newHost();
    const res = await send("/v1/connections", asHost(host, a), askBody);
    expect(res.status).toBe(201);
    const auth = (await res.json()) as { request_id: string; match_number?: number };
    expect(auth.match_number).toBeUndefined();
    const [row] = await testDb
      .select()
      .from(agentConnections)
      .where(eq(agentConnections.id, auth.request_id));
    expect(row).toMatchObject({
      clientId: host,
      userId: a,
      operatorAgentId: HOSTED,
      matchNumber: null,
    });

    const read = await app.request(`/v1/connections/requests/${auth.request_id}`, {
      headers: asHost(host, a),
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ state: "PENDING", matchNumber: null });
  });

  test("through its own operator when it linked one", async () => {
    const a = await newUser();
    const host = newHost();
    const own = await newOperator(host);
    const res = await send("/v1/connections", asHost(host, a), askBody);
    expect(res.status).toBe(201);
    const { request_id } = (await res.json()) as { request_id: string };
    const [row] = await testDb
      .select()
      .from(agentConnections)
      .where(eq(agentConnections.id, request_id));
    expect(row?.operatorAgentId).toBe(own);
  });

  test("and cannot ask at all where no hosted operator serves it", async () => {
    const bare = createApp({
      db: testDb,
      kv: testKv,
      log: pino({ level: "silent" }),
      authenticate: headerPrincipal,
    });
    const res = await bare.request("/v1/connections", {
      method: "POST",
      headers: {
        "idempotency-key": ulid(),
        "content-type": "application/json",
        ...asHost(newHost(), await newUser()),
      },
      body: JSON.stringify(askBody),
    });
    expect(res.status).toBe(403);
  });
});

describe("cross-user access", () => {
  test("user A's app reads, lists and acts on none of user B's requests, mandates or purchases", async () => {
    const [a, b] = [await newUser(), await newUser()];
    // One app, as a host that registered once serves many users.
    const host = newHost();
    const asked = await send("/v1/connections", asHost(host, b), askBody);
    const { request_id } = (await asked.json()) as { request_id: string };
    const m = await approved(b, host);
    const root = await sealed(asHost(host, b), m.id);
    const [p] = await (async () => {
      await countersign(asHost(host, b), m, root);
      return purchasesOf(m.id);
    })();
    expect(p).toBeDefined();

    const asA = asHost(host, a);
    expect(
      (await app.request(`/v1/connections/requests/${request_id}`, { headers: asA })).status,
    ).toBe(404);
    const listed = await app.request(`/v1/operators/${HOSTED}/mandates`, { headers: asA });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { mandates: { id: string }[] }).mandates).toEqual([]);
    expect((await send(`/v1/mandates/${m.id}/check`, asA, { cart })).status).toBe(404);
    expect(
      (await send(`/v1/mandates/${m.id}/changes`, asA, { note: "Needs $40 more for shipping" }))
        .status,
    ).toBe(404);
    expect((await evidence(asA, m.id)).status).toBe(404);
    expect((await countersign(asA, m, root)).status).toBe(404);
    expect((await app.request(`/v1/purchases/${p?.id}`, { headers: asA })).status).toBe(404);
    expect((await purchasesOf(m.id)).length).toBe(1);

    // User B's own app reads all of it.
    const asB = asHost(host, b);
    expect(
      (await app.request(`/v1/connections/requests/${request_id}`, { headers: asB })).status,
    ).toBe(200);
    const mine = await app.request(`/v1/operators/${HOSTED}/mandates`, { headers: asB });
    expect(
      ((await mine.json()) as { mandates: { id: string }[] }).mandates.map((x) => x.id),
    ).toEqual([m.id]);
    expect((await app.request(`/v1/purchases/${p?.id}`, { headers: asB })).status).toBe(200);
  });
});

describe("confused deputy", () => {
  test("host X acts under no mandate its user approved for host Y", async () => {
    const a = await newUser();
    const [x, y] = [newHost(), newHost()];
    const m = await approved(a, y);
    const root = await sealed(asHost(y, a), m.id);
    const asX = asHost(x, a);
    const listed = await app.request(`/v1/operators/${HOSTED}/mandates`, { headers: asX });
    expect(((await listed.json()) as { mandates: unknown[] }).mandates).toEqual([]);
    expect((await send(`/v1/mandates/${m.id}/check`, asX, { cart })).status).toBe(404);
    expect((await evidence(asX, m.id)).status).toBe(404);
    expect((await countersign(asX, m, root)).status).toBe(404);
    expect(await purchasesOf(m.id)).toEqual([]);
  });

  test("an app the user disconnected acts under the mandate no more", async () => {
    const a = await newUser();
    const host = newHost();
    const m = await approved(a, host);
    const root = await sealed(asHost(host, a), m.id);
    await testDb
      .update(agentConnections)
      .set({ disconnectedAt: new Date() })
      .where(eq(agentConnections.mandateId, m.id));
    expect((await countersign(asHost(host, a), m, root)).status).toBe(404);
    expect(await purchasesOf(m.id)).toEqual([]);
  });

  test("Keelson closes a mandate only for an app acting for its user, and only the hosted operator's", async () => {
    const a = await newUser();
    const host = newHost();
    const m = await approved(a, host);
    const root = await sealed(asHost(host, a), m.id);
    // The hosted operator's own client closes its mandates with its own key.
    const own = await countersign(asOperator(KEELSON_CLIENT), m, root);
    expect(own.status).toBe(422);
    expect(((await own.json()) as { type: string }).type).toMatch(/invalid-closed-mandate$/);

    const linked = newHost();
    const operator = await newOperator(linked);
    const theirs = await approved(a, linked, operator);
    const theirRoot = await sealed(asHost(linked, a), theirs.id);
    const res = await countersign(asHost(linked, a), theirs, theirRoot);
    expect(res.status).toBe(422);
    expect(await purchasesOf(theirs.id)).toEqual([]);
    expect(await purchasesOf(m.id)).toEqual([]);
  });

  test("without the hosted operator's key, nothing is closed", async () => {
    const keyless = createApp({
      db: testDb,
      kv: testKv,
      log: pino({ level: "silent" }),
      authenticate: headerPrincipal,
      demoAgentId: HOSTED,
      tee,
    });
    const a = await newUser();
    const host = newHost();
    const m = await approved(a, host);
    const root = await sealed(asHost(host, a), m.id);
    const res = await keyless.request("/v1/countersign", {
      method: "POST",
      headers: {
        "idempotency-key": ulid(),
        "content-type": "application/json",
        ...asHost(host, a),
      },
      body: JSON.stringify({
        authorizationId: m.authorizationId,
        mandateId: m.id,
        cart,
        unit,
        evidenceRoot: root,
      }),
    });
    expect(res.status).toBe(503);
    expect(await purchasesOf(m.id)).toEqual([]);
  });

  test("the hosted key signs only the cart the app submitted, for this request, and the legs get it", async () => {
    const a = await newUser();
    const host = newHost();
    const m = await approved(a, host);
    const root = await sealed(asHost(host, a), m.id);
    const requestId = ulid();
    legA.body = undefined;
    const res = await countersign(asHost(host, a), m, root, { requestId });
    // Leg A is down: the purchase fails after the mandate was closed and sent.
    expect(res.status).toBe(503);
    const sent = legA.body as
      | { request_id: string; closed_mandate: string; cart: Cart }
      | undefined;
    expect(sent?.request_id).toBe(requestId);
    expect(sent?.cart).toEqual(cart);
    const token = sent?.closed_mandate ?? "";
    expect(token.startsWith(OPEN)).toBe(true);
    const now = Math.floor(Date.now() / 1000);
    const bound = { requestId, now, maxSkewSec: 60 };
    const hashOf = (c: Cart) => `sha256:${toHex(cartHash(c)).slice(2)}`;
    await expect(
      verifyKeyBinding(token, hostedCnf as never, { ...bound, cartHash: hashOf(cart) }),
    ).resolves.toBeTypeOf("number");
    const other = { ...cart, lines: cart.lines.map((l) => ({ ...l, qty: l.qty + 1 })) };
    await expect(
      verifyKeyBinding(token, hostedCnf as never, { ...bound, cartHash: hashOf(other) }),
    ).rejects.toBeInstanceOf(ClosedMandateError);
    await expect(
      verifyKeyBinding(token, hostedCnf as never, {
        ...bound,
        requestId: ulid(),
        cartHash: hashOf(cart),
      }),
    ).rejects.toBeInstanceOf(ClosedMandateError);
    const [row] = await purchasesOf(m.id);
    expect(row).toMatchObject({ id: requestId, clientId: host, state: "FAILED" });
  });

  test("a cart other than the evidence's is refused before anything is signed", async () => {
    const a = await newUser();
    const host = newHost();
    const m = await approved(a, host);
    const root = await sealed(asHost(host, a), m.id);
    legA.body = undefined;
    const other = { ...cart, lines: cart.lines.map((l) => ({ ...l, qty: l.qty + 1 })) };
    const res = await countersign(asHost(host, a), m, root, { cart: other });
    expect(res.status).toBe(422);
    expect(legA.body).toBeUndefined();
    expect(await purchasesOf(m.id)).toEqual([]);
  });
});

describe("the hosted operator's own client", () => {
  test("reaches no mandate a user approved for an app acting for them", async () => {
    const a = await newUser();
    const host = newHost();
    const m = await approved(a, host);
    const root = await sealed(asHost(host, a), m.id);
    const keelson = asOperator(KEELSON_CLIENT);
    const listed = await app.request(`/v1/operators/${HOSTED}/mandates`, { headers: keelson });
    expect(listed.status).toBe(200);
    const ids = ((await listed.json()) as { mandates: { id: string }[] }).mandates.map((x) => x.id);
    expect(ids).not.toContain(m.id);
    expect((await send(`/v1/mandates/${m.id}/check`, keelson, { cart })).status).toBe(404);
    expect((await evidence(keelson, m.id)).status).toBe(404);
    const closed = [
      "e30.e30.sig",
      b64(["salt", "mandate", { v: "keelson.mandate.1", mid: m.id }]),
      `e30.${b64({ nonce: ulid() })}.sig`,
    ].join("~");
    const res = await send("/v1/countersign", keelson, {
      authorizationId: m.authorizationId,
      closedMandate: closed,
      cart,
      unit,
      evidenceRoot: root,
    });
    expect(res.status).toBe(404);
    expect(await purchasesOf(m.id)).toEqual([]);
  });
});

describe("scope escalation", () => {
  test("a token a user delegated never carries more than the delegated scopes", () => {
    const all =
      "countersign:write evidence:write evidence:disclose evidence:decrypt alibis:read disputes:read operators:write merchants:write mandates:request purchases:write";
    expect(tokenScopes({ scope: all, sub: "user-1", azp: "host" }).sort()).toEqual(
      [...DELEGATED].sort(),
    );
    // A client's own token (client credentials) keeps what it was granted.
    expect(tokenScopes({ scope: "countersign:write", azp: "agent" })).toEqual([
      "countersign:write",
    ]);
    expect(tokenScopes({ scope: "countersign:write", sub: "agent", azp: "agent" })).toEqual([
      "countersign:write",
    ]);
  });

  test("an app acting for a user is refused at every route only an operator's own client may use", async () => {
    const a = await newUser();
    const host = newHost();
    const m = await approved(a, host);
    const p = ulid();
    const asA = asHost(host, a);
    const routes: [string, string, unknown?][] = [
      ["POST", "/v1/operators", {}],
      ["POST", "/v1/connections/token", undefined],
      ["PUT", "/v1/embed/origins", { origins: [] }],
      ["POST", "/v1/connections/embed", {}],
      ["POST", "/v1/observations/channel3", {}],
      ["GET", `/v1/observations/channel3/${ulid()}`],
      ["POST", `/v1/mandates/${m.id}/holds`, {}],
      ["PUT", `/v1/purchases/${p}/paypal-transaction`, { transactionId: "X" }],
      ["POST", `/v1/purchases/${p}/tracking`, {}],
      ["POST", `/v1/operators/${HOSTED}/mandates/${m.id}/runs`, { state: "started" }],
      ["POST", `/v1/bonds/${HOSTED}/withdrawals`, {}],
      ["POST", "/v1/merchants/payout-address", {}],
      ["GET", `/v1/evidence/0x${"ab".repeat(32)}/items/0`],
    ];
    for (const [method, path, body] of routes) {
      const res = await send(path, asA, body, method);
      expect([path, res.status]).toEqual([path, 403]);
      expect(res.headers.get("www-authenticate") ?? "").toContain("insufficient_scope");
    }
  });

  test("each delegated route asks for its own scope, and none stands for another", async () => {
    const a = await newUser();
    const host = newHost();
    const m = await approved(a, host);
    const only = (scope: string) => asHost(host, a, [scope]);
    const challenged = async (res: Response, scope: string) => {
      expect(res.status).toBe(403);
      expect(res.headers.get("www-authenticate")).toContain(`scope="${scope}"`);
    };
    await challenged(
      await send("/v1/connections", only("purchases:write"), askBody),
      "mandates:request",
    );
    await challenged(
      await send(`/v1/mandates/${m.id}/check`, only("mandates:request"), { cart }),
      "purchases:write",
    );
    await challenged(
      await countersign(only("mandates:request"), m, `0x${"ab".repeat(32)}`),
      "purchases:write",
    );
    expect((await evidence(only("purchases:write"), m.id)).status).toBe(403);
  });
});

describe("the kill switch", () => {
  test("stopping every agent ends what the app may do under the user's mandates", async () => {
    const a = await newUser();
    const host = newHost();
    const m = await approved(a, host);
    const root = await sealed(asHost(host, a), m.id);
    const stopped = await send("/v1/agents/stop", asUser(a));
    expect(stopped.status).toBe(200);
    expect((await countersign(asHost(host, a), m, root)).status).toBe(404);
    expect((await evidence(asHost(host, a), m.id)).status).toBe(404);
    const listed = await app.request(`/v1/operators/${HOSTED}/mandates`, {
      headers: asHost(host, a),
    });
    expect(((await listed.json()) as { mandates: unknown[] }).mandates).toEqual([]);
    expect(await purchasesOf(m.id)).toEqual([]);
  });
});

describe("the hosted operator's caps for apps Keelson does not know", () => {
  const caps = { perUserMinor: 30_000n, totalMinor: 50_000n };
  /** A hosted operator of its own, so that what other tests leave open counts for nothing. */
  async function hostedWithCaps() {
    const agentId = BigInt(`0x${randomBytes(7).toString("hex")}`);
    await testDb.insert(operators).values({
      agentId,
      chainId: 421614,
      agentRegistry: REGISTRY,
      name: "Keelson",
      cnfJwk: hostedCnf,
      clientId: `keelson-${ulid()}`,
    });
    const capped = createApp({
      db: testDb,
      kv: testKv,
      log: pino({ level: "silent" }),
      authenticate: headerPrincipal,
      appOrigin: "https://app.keelson.finance",
      demoAgentId: agentId,
      hostedAgentKey: hostedPair.privateKey,
      hostedCaps: caps,
      tee,
    });
    const ask = (headers: Record<string, string>, totalMinor: number) =>
      capped.request("/v1/connections", {
        method: "POST",
        headers: { "idempotency-key": ulid(), "content-type": "application/json", ...headers },
        body: JSON.stringify({
          ...askBody,
          limits: { ...askBody.limits, perPurchaseMinor: 5_000, totalMinor },
        }),
      });
    return { CAPPED: agentId, capped, ask };
  }
  /** A host that registered itself (RFC 7591) with these redirect URIs. */
  async function registered(redirectUris: string[]): Promise<string> {
    const clientId = newHost();
    await testDb.insert(oauthClient).values({
      id: ulid(),
      clientId,
      redirectUris,
      tokenEndpointAuthMethod: "none",
      name: "A host",
    });
    return clientId;
  }

  test("known hosts are the ones whose every redirect URI a known host registers", () => {
    expect(knownHost(["https://claude.ai/api/mcp/auth_callback"])).toBe(true);
    expect(knownHost(["https://chatgpt.com/connector_platform_oauth_redirect"])).toBe(true);
    expect(knownHost(["cursor://anysphere.cursor-mcp/oauth/callback"])).toBe(true);
    expect(knownHost(["http://localhost:53682/callback", "http://127.0.0.1:8787/callback"])).toBe(
      true,
    );
    expect(knownHost([])).toBe(false);
    expect(knownHost(["https://claude.ai/api/mcp/auth_callback", "https://evil.example/cb"])).toBe(
      false,
    );
    expect(knownHost(["https://claude.ai.evil.example/api/mcp/auth_callback"])).toBe(false);
    expect(knownHost(["http://localhost:53682/callback/../steal"])).toBe(false);
  });

  test("an unknown app asks one user for no more than the per-user cap, counting what is left on its mandates", async () => {
    const { CAPPED, capped, ask } = await hostedWithCaps();
    const a = await newUser();
    const host = await registered(["https://unknown.example/callback"]);
    const over = await ask(asHost(host, a), 30_001);
    expect(over.status).toBe(422);
    expect(await over.json()).toMatchObject({
      type: expect.stringContaining("hosted-cap"),
      detail: expect.stringContaining("$300.00"),
    });
    expect((await ask(asHost(host, a), 30_000)).status).toBe(201);
    // Another unknown app of the same user shares the cap.
    await approved(a, host, CAPPED, 20_000n);
    const other = await registered(["https://other.example/callback"]);
    expect((await ask(asHost(other, a), 10_001)).status).toBe(422);
    expect((await ask(asHost(other, a), 10_000)).status).toBe(201);
    // Only in the cap's currency, so that the caps add up.
    const eur = await capped.request("/v1/connections", {
      method: "POST",
      headers: {
        "idempotency-key": ulid(),
        "content-type": "application/json",
        ...asHost(other, a),
      },
      body: JSON.stringify({ ...askBody, limits: { ...askBody.limits, currency: "EUR" } }),
    });
    expect(eur.status).toBe(422);
    expect(((await eur.json()) as { detail: string }).detail).toContain("USD only");
    // A host with no registration at all is as unknown.
    expect((await ask(asHost(newHost(), a), 10_001)).status).toBe(422);
  });

  test("a known host asks with the standard limits", async () => {
    const { CAPPED, ask } = await hostedWithCaps();
    const a = await newUser();
    const claude = await registered(["https://claude.ai/api/mcp/auth_callback"]);
    await approved(a, claude, CAPPED, 90_000n);
    expect((await ask(asHost(claude, a), 100_000)).status).toBe(201);
    // What a known host holds does not count against unknown apps.
    const unknown = await registered(["https://unknown.example/callback"]);
    expect((await ask(asHost(unknown, a), 30_000)).status).toBe(201);
  });

  test("the total cap counts every user's live mandates for unknown apps; ended ones do not count", async () => {
    const { CAPPED, ask } = await hostedWithCaps();
    const [a, b, c] = [await newUser(), await newUser(), await newUser()];
    const host = await registered(["https://unknown.example/callback"]);
    const first = await approved(a, host, CAPPED, 25_000n);
    await approved(b, host, CAPPED, 20_000n);
    const res = await ask(asHost(host, c), 5_001);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { detail: string }).detail).toContain("has reached");
    expect((await ask(asHost(host, c), 5_000)).status).toBe(201);
    await testDb
      .update(mandates)
      .set({ revokeRequestedAt: new Date() })
      .where(eq(mandates.id, first.id));
    expect((await ask(asHost(host, c), 30_000)).status).toBe(201);
  });

  test("a change is measured in place of the mandate it replaces", async () => {
    const { CAPPED, capped } = await hostedWithCaps();
    const a = await newUser();
    const host = await registered(["https://unknown.example/callback"]);
    const m = await approved(a, host, CAPPED, 25_000n);
    const change = (totalMinor: number) =>
      capped.request(`/v1/mandates/${m.id}/changes`, {
        method: "POST",
        headers: {
          "idempotency-key": ulid(),
          "content-type": "application/json",
          ...asHost(host, a),
        },
        body: JSON.stringify({
          note: "The shoes went up.",
          limits: { totalMinor, perPurchaseMinor: 5_000, until: inDays(2) },
        }),
      });
    const over = await change(30_001);
    expect(over.status).toBe(422);
    expect(await over.json()).toMatchObject({ type: expect.stringContaining("hosted-cap") });
    const fits = await change(30_000);
    expect(await fits.json()).toMatchObject({ request_id: expect.any(String) });
    expect(fits.status).toBe(201);
  });

  test("the approval itself is measured under a lock, so concurrent approvals cannot pass a cap", async () => {
    const { CAPPED } = await hostedWithCaps();
    const a = await newUser();
    const host = await registered(["https://unknown.example/callback"]);
    await approved(a, host, CAPPED, 20_000n);
    const input = {
      clientId: host,
      operatorAgentId: CAPPED,
      userId: a,
      currency: "USD",
      amountMinor: 10_000n,
    };
    const deps = { demoAgentId: CAPPED, hostedCaps: caps };
    // Two approvals of 10,000 race; each stores its mandate in the transaction that measured it.
    const approve = () =>
      testDb.transaction(async (tx) => {
        const over = await hostedCapError(tx, deps, input, true);
        if (!over) await approved(a, host, CAPPED, 10_000n).then(() => undefined);
        return over;
      });
    const results = await Promise.all([approve(), approve()]);
    expect(results.filter((r) => r === undefined)).toHaveLength(1);
    // Another operator's mandates, or an uncapped deployment, are never measured.
    expect(
      await hostedCapError(testDb, deps, {
        ...input,
        operatorAgentId: HOSTED,
        amountMinor: 10n ** 9n,
      }),
    ).toBeUndefined();
    expect(
      await hostedCapError(testDb, { demoAgentId: CAPPED }, { ...input, amountMinor: 10n ** 9n }),
    ).toBeUndefined();
  });

  test("an app with an operator of its own is never capped", async () => {
    const { ask } = await hostedWithCaps();
    const a = await newUser();
    const own = newHost();
    await newOperator(own);
    expect((await ask(asHost(own, a), 100_000)).status).toBe(201);
  });
});

describe("disconnecting one app acting through the hosted operator", () => {
  test("ends that app's mandates, requests and grant only; other apps stay connected", async () => {
    const a = await newUser();
    const [x, y] = [newHost(), newHost()];
    for (const host of [x, y]) {
      await testDb.insert(oauthClient).values({
        id: ulid(),
        clientId: host,
        redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
        tokenEndpointAuthMethod: "none",
      });
    }
    const mx = await approved(a, x);
    const my = await approved(a, y);
    await testDb.insert(oauthConsent).values({
      id: ulid(),
      clientId: x,
      userId: a,
      scopes: DELEGATED,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const pending = await send("/v1/connections", asHost(x, a), askBody);
    expect(pending.status).toBe(201);

    const listed = await app.request("/v1/agents", { headers: asUser(a) });
    const rows = (
      (await listed.json()) as { agents: { agentId: string; clientId: string | null }[] }
    ).agents;
    expect(
      rows
        .filter((r) => r.agentId === HOSTED.toString())
        .map((r) => r.clientId)
        .sort(),
    ).toEqual([x, y].sort());

    const before = Math.floor(Date.now() / 1000) - 1;
    const res = await send(`/v1/agents/${HOSTED}/disconnect?client=${x}`, asUser(a));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: 1 });

    const [ended] = await testDb.select().from(mandates).where(eq(mandates.id, mx.id));
    const [kept] = await testDb.select().from(mandates).where(eq(mandates.id, my.id));
    expect(ended?.revokeRequestedAt).not.toBeNull();
    expect(kept?.revokeRequestedAt).toBeNull();
    const { request_id } = (await pending.json()) as { request_id: string };
    const [denied] = await testDb
      .select()
      .from(agentConnections)
      .where(eq(agentConnections.id, request_id));
    expect(denied?.state).toBe("DENIED");
    expect(await testDb.select().from(oauthConsent).where(eq(oauthConsent.clientId, x))).toEqual(
      [],
    );
    // Its access tokens issued before now are refused; the other app's are not.
    expect(await tokenStopped(testDb, a, x, before)).toBe(true);
    expect(await tokenStopped(testDb, a, y, before)).toBe(false);

    expect((await evidence(asHost(y, a), my.id)).status).toBe(201);
    expect((await evidence(asHost(x, a), mx.id)).status).toBe(404);

    // Another user's app, or one never connected, is not found.
    expect(
      (await send(`/v1/agents/${HOSTED}/disconnect?client=${newHost()}`, asUser(a))).status,
    ).toBe(404);
  });
});
