import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { serve } from "@hono/node-server";
import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  agentConnections,
  createDb,
  type Db,
  eq,
  mandates,
  operators,
  purchases,
  teeSigners,
} from "@keelson/db";
import { buildManifest, canonicalBytes, MEDIA_TYPES, type SealedItem } from "@keelson/evidence";
import { buildSdPayload, parseMandate } from "@keelson/mandate";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { pino } from "pino";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import demo from "../../../packages/mandate/test/fixtures/demo-mandate.json" with { type: "json" };
import { createApp } from "../src/app.ts";
import { apiAudience, createAuth } from "../src/auth.ts";
import { authenticate } from "../src/middleware/auth.ts";
import { createTee } from "../src/tee/config.ts";
import { testAuthEnv, testDb, testKv } from "./setup.ts";
import { carts } from "./tee-live.ts";

const secret = randomBytes(32).toString("base64url");
let app!: OpenAPIHono;
const server = serve({ fetch: (req) => app.fetch(req), port: 0, hostname: "127.0.0.1" });
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// Leg A over HTTP, down: a countersign that passes every check of the API ends there.
const legA: { body?: { request_id: string; closed_mandate: string } | undefined } = {};
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

const HOSTED = BigInt(`0x${randomBytes(7).toString("hex")}`);
const hosted = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);
const auth = createAuth(testDb, testAuthEnv(baseURL, secret));
app = createApp({
  db: testDb,
  kv: testKv,
  log: pino({ level: "silent" }),
  auth,
  appOrigin: baseURL,
  authBaseUrl: baseURL,
  authenticate: authenticate(auth, baseURL, testDb),
  demoAgentId: HOSTED,
  hostedAgentKey: hosted.privateKey,
  // Every user here is new, so only the per-user cap ever binds.
  hostedCaps: { perUserMinor: 30_000n, knownPerUserMinor: 60_000n, totalMinor: 10n ** 15n },
  tee: createTee(
    {
      TEE_A_URL: legUrl,
      TEE_B_URL: legUrl,
      KEELSON_TEE_TOKEN: "unused",
      ARBITRUM_SEPOLIA_RPC_URL: "http://127.0.0.1:9",
    },
    { a: 2_000, b: 500 },
  ),
});

const helpers = betterAuth({
  database: drizzleAdapter(testDb, { provider: "pg" }),
  secret,
  baseURL,
  plugins: [testUtils()],
});

async function newUser(): Promise<{ id: string; headers: Headers }> {
  const { test: utils } = await helpers.$context;
  const user = await utils.saveUser(utils.createUser());
  return { id: user.id, headers: await utils.getAuthHeaders({ userId: user.id }) };
}

beforeAll(async () => {
  const jwk = await crypto.subtle.exportKey("jwk", hosted.publicKey);
  await testDb.insert(operators).values({
    agentId: HOSTED,
    chainId: 421614,
    agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
    name: "Keelson",
    cnfJwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
    clientId: `keelson-${ulid()}`,
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
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => leg.close(resolve));
});

const REDIRECT = "http://127.0.0.1:33418/callback";
const REASON =
  "I am Claude, buying the running shoes you asked for in this chat. I compare prices at RunFast and check out only what you named.";
const DELEGATED = ["alibis:read", "mandates:request", "evidence:write", "purchases:write"];

/** An MCP host registering itself (RFC 7591) as a public client, the way claude.ai does. */
async function registerHost(redirect = REDIRECT): Promise<string> {
  const res = await app.request("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirect],
      client_name: "Claude",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
    }),
  });
  expect(res.status).toBeLessThan(300);
  return ((await res.json()) as { client_id: string }).client_id;
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

const authorize = (clientId: string, headers: Headers, challenge: string, scope?: string) =>
  app.request(
    `/api/auth/oauth2/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      resource: apiAudience,
      state: "s1",
      code_challenge: challenge,
      code_challenge_method: "S256",
      ...(scope ? { scope } : {}),
    })}`,
    { headers },
  );

interface Tokens {
  access_token: string;
  refresh_token?: string;
  scope: string;
}

const tokenRequest = (body: Record<string, string>) =>
  app.request("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });

/** The authorization code flow with PKCE: the user consents on the consent page, the host redeems the code. */
async function grant(
  clientId: string,
  user: { headers: Headers },
  scope?: string,
): Promise<Tokens> {
  const { verifier, challenge } = pkce();
  const res = await authorize(clientId, user.headers, challenge, scope);
  expect(res.status).toBe(302);
  let at = new URL(res.headers.get("location") ?? "");
  if (!at.searchParams.has("code")) {
    const accepted = await app.request("/api/auth/oauth2/consent", {
      method: "POST",
      headers: { cookie: user.headers.get("cookie") ?? "", "content-type": "application/json" },
      body: JSON.stringify({ accept: true, oauth_query: at.search.slice(1) }),
    });
    expect(accepted.status).toBe(200);
    at = new URL(((await accepted.json()) as { url: string }).url);
  }
  const token = await tokenRequest({
    grant_type: "authorization_code",
    code: at.searchParams.get("code") ?? "",
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
    resource: apiAudience,
  });
  expect(token.status).toBe(200);
  return (await token.json()) as Tokens;
}

const refresh = (clientId: string, refreshToken: string) =>
  tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    resource: apiAudience,
  });

const bearer = (token: string, body?: unknown) => ({
  method: body === undefined ? "GET" : "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "idempotency-key": ulid(),
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const ask = (token: string) =>
  app.request(
    "/v1/connections",
    bearer(token, {
      name: "Claude",
      reason: REASON,
      limits: {
        currency: "USD",
        perPurchaseMinor: 20_000,
        totalMinor: 20_000,
        merchants: ["mrc_runfast"],
        until: new Date(Date.now() + 86_400_000).toISOString(),
      },
    }),
  );

/** What the approval page leaves once the user signs: the mandate, and the request answered. */
async function approve(requestId: string, userId: string) {
  const id = ulid();
  await testDb.insert(mandates).values({
    id,
    userId,
    operatorAgentId: HOSTED,
    state: "ACTIVE",
    currency: "USD",
    maxMinor: 20_000n,
    remainingMinor: 20_000n,
    merchantIds: [carts.demo.cart.merchant],
    expiresAt: new Date(Date.now() + 86_400_000),
    openMandate: `e30.e30.c2ln~~${Buffer.from('{"alg":"ES256"}').toString("base64url")}.e30.c2ln~`,
    mandateHash: randomBytes(32),
    holdMode: "mandate",
    paypalOrderId: `ORDER${randomBytes(6).toString("hex").toUpperCase()}`,
    paypalAuthorizationId: `AUTH${randomBytes(6).toString("hex").toUpperCase()}`,
    ...(await buildSdPayload(parseMandate(structuredClone(demo)), () => randomBytes(16))),
  });
  await testDb
    .update(agentConnections)
    .set({ state: "APPROVED", mandateId: id, decidedAt: new Date() })
    .where(eq(agentConnections.id, requestId));
  return id;
}

async function evidence(token: string, mandateId: string) {
  const salt = () => crypto.getRandomValues(new Uint8Array(32));
  const { cart } = carts.demo;
  const items: SealedItem[] = [
    {
      type: "api.product",
      mediaType: MEDIA_TYPES["api.product"],
      bytes: canonicalBytes({ sku: cart.lines[0]?.sku }),
      salt: salt(),
    },
    {
      type: "api.cart",
      mediaType: MEDIA_TYPES["api.cart"],
      bytes: canonicalBytes(cart),
      salt: salt(),
    },
    {
      type: "llm.observation",
      mediaType: MEDIA_TYPES["llm.observation"],
      bytes: new TextEncoder().encode("The shoes, size 10, in stock."),
      salt: salt(),
    },
  ];
  const res = await app.request(
    "/v1/evidence",
    bearer(token, {
      mandateId,
      manifest: buildManifest(items),
      items: items.map((i) => ({
        type: i.type,
        mediaType: i.mediaType,
        salt: Buffer.from(i.salt).toString("base64"),
        bytes: Buffer.from(i.bytes).toString("base64"),
      })),
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { evidenceRoot: string }).evidenceRoot;
}

/** The API's resource is its production origin; this fetch reaches the test server in its place. */
const viaTestServer: typeof fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== apiAudience) return fetch(input, init);
  return fetch(new URL(`${url.pathname}${url.search}`, baseURL), init);
};

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: "claude-ai", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", apiAudience), {
      fetch: viaTestServer,
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

const mcpPost = (token: string) =>
  fetch(new URL("/mcp", baseURL), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      host: new URL(apiAudience).host,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

describe("an MCP host connected over OAuth with dynamic client registration", () => {
  test("gets the delegated scopes, a refresh token, and never an operator's", async () => {
    const host = await registerHost();
    const user = await newUser();
    const tokens = await grant(host, user);
    expect(tokens.scope.split(" ").sort()).toEqual([...DELEGATED, "offline_access"].sort());
    expect(tokens.refresh_token).toBeTypeOf("string");

    const { challenge } = pkce();
    const greedy = await authorize(host, user.headers, challenge, "countersign:write");
    expect(new URL(greedy.headers.get("location") ?? "").searchParams.get("error")).toBe(
      "invalid_scope",
    );
    // An operator's own route stays closed to the user's token.
    const link = await app.request("/v1/connections/token", {
      ...bearer(tokens.access_token, {}),
    });
    expect(link.status).toBe(403);
  });

  test("asks its own user for a mandate, bound to them from the start; another user's token reads none of it", async () => {
    const host = await registerHost();
    const [a, b] = [await newUser(), await newUser()];
    const ofA = await grant(host, a);
    const ofB = await grant(host, b);
    const res = await ask(ofA.access_token);
    expect(res.status).toBe(201);
    const { request_id, match_number } = (await res.json()) as {
      request_id: string;
      match_number?: number;
    };
    expect(match_number).toBeUndefined();
    const [row] = await testDb
      .select()
      .from(agentConnections)
      .where(eq(agentConnections.id, request_id));
    expect(row).toMatchObject({ clientId: host, userId: a.id, operatorAgentId: HOSTED });
    const read = (token: string) =>
      app.request(`/v1/connections/requests/${request_id}`, bearer(token));
    expect((await read(ofA.access_token)).status).toBe(200);
    expect((await read(ofB.access_token)).status).toBe(404);
  });

  test("buys over MCP: asks, finds the mandate, seals evidence and countersigns, closed by Keelson", async () => {
    const host = await registerHost();
    const user = await newUser();
    const { access_token } = await grant(host, user);
    const client = await mcpClient(access_token);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("keelson.request_countersign");

    const asked = await client.callTool({
      name: "keelson.request_mandate",
      arguments: {
        name: "Claude",
        reason: REASON,
        perPurchaseMinor: 20_000,
        totalMinor: 20_000,
        until: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    const waiting = asked.structuredContent as {
      status: string;
      requestId: string;
      matchNumber: number | null;
    };
    expect(waiting).toMatchObject({ status: "pending_approval", matchNumber: null });
    const mandateId = await approve(waiting.requestId, user.id);
    const answered = await client.callTool({
      name: "keelson.get_request",
      arguments: { requestId: waiting.requestId },
    });
    expect(answered.structuredContent).toMatchObject({ status: "approved", mandateId });
    const confirmed = await client.callTool({
      name: "keelson.confirm_mandate",
      arguments: { mandateId },
    });
    expect(confirmed.structuredContent).toMatchObject({
      status: "success",
      mandate: { id: mandateId, held: true },
    });

    const evidenceRoot = await evidence(access_token, mandateId);
    legA.body = undefined;
    const bought = await client.callTool({
      name: "keelson.request_countersign",
      arguments: { mandateId, evidenceRoot, cart: carts.demo.cart },
    });
    // The legs got the mandate Keelson closed; leg A is down here, so nothing is captured.
    const sent = legA.body as { request_id: string; closed_mandate: string } | undefined;
    expect(sent?.closed_mandate.split("~").length).toBe(4);
    const [purchase] = await testDb
      .select()
      .from(purchases)
      .where(eq(purchases.mandateId, mandateId));
    expect(purchase).toMatchObject({ id: sent?.request_id, clientId: host });
    expect(bought.structuredContent).toMatchObject({
      status: "error",
      next: { tool: "keelson.get_purchase" },
    });
    await client.close();
  });
});

test("a host that consented to less is challenged on MCP for the scope a tool needs (step-up)", async () => {
  const host = await registerHost();
  const { access_token } = await grant(host, await newUser(), "alibis:read mandates:request");
  const res = await fetch(new URL("/mcp", baseURL), {
    method: "POST",
    headers: {
      authorization: `Bearer ${access_token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
      host: new URL(apiAudience).host,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "keelson.request_countersign",
        arguments: {
          mandateId: ulid(),
          evidenceRoot: `0x${"ab".repeat(32)}`,
          cart: carts.demo.cart,
        },
      },
    }),
  });
  expect(res.status).toBe(403);
  const challenge = res.headers.get("www-authenticate") ?? "";
  expect(challenge).toContain('error="insufficient_scope"');
  expect(challenge).toContain('scope="purchases:write"');
});

test("the consent page shows the hosted operator answering for a host with none, and its spending request names it", async () => {
  const host = await registerHost();
  const user = await newUser();
  const details = JSON.stringify([
    {
      type: "keelson_mandate",
      name: "Claude",
      reason: REASON,
      limits: {
        currency: "USD",
        perPurchaseMinor: 5_000,
        totalMinor: 5_000,
        merchants: ["mrc_runfast"],
        until: new Date(Date.now() + 86_400_000).toISOString(),
      },
    },
  ]);
  const { challenge } = pkce();
  const res = await app.request(
    `/api/auth/oauth2/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: host,
      redirect_uri: REDIRECT,
      resource: apiAudience,
      state: "s1",
      code_challenge: challenge,
      code_challenge_method: "S256",
      authorization_details: details,
    })}`,
    { headers: user.headers },
  );
  const oauthQuery = new URL(res.headers.get("location") ?? "").search.slice(1);
  const consent = (path: string) =>
    app.request(path, {
      method: "POST",
      headers: {
        cookie: user.headers.get("cookie") ?? "",
        "content-type": "application/json",
        "idempotency-key": ulid(),
      },
      body: JSON.stringify({ oauthQuery }),
    });
  const read = await consent("/v1/oauth/consent");
  expect(await read.json()).toMatchObject({
    client: { id: host, verified: false },
    agent: { agentId: HOSTED.toString(), operator: "Keelson", hosted: true },
    scopes: [...DELEGATED, "offline_access"],
    // A loopback redirect URI names no host, so it gets the lower tier.
    hostedCap: { perUserMinor: "30000", currency: "USD", knownHost: false },
    spendingError: null,
  });
  const asked = await consent("/v1/oauth/consent/connection");
  expect(asked.status).toBe(201);
  const { userCode } = (await asked.json()) as { userCode: string };
  const [row] = await testDb
    .select()
    .from(agentConnections)
    .where(eq(agentConnections.userCode, userCode));
  expect(row).toMatchObject({ clientId: host, userId: user.id, operatorAgentId: HOSTED });
});

describe("revocation", () => {
  test("a refresh token works until the host revokes it (RFC 7009)", async () => {
    const host = await registerHost();
    const user = await newUser();
    const tokens = await grant(host, user);
    const refreshed = await refresh(host, tokens.refresh_token as string);
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as Tokens;
    expect((await ask(next.access_token)).status).toBe(201);
    const revoked = await app.request("/api/auth/oauth2/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: next.refresh_token as string,
        token_type_hint: "refresh_token",
        client_id: host,
      }),
    });
    expect(revoked.status).toBe(200);
    expect((await refresh(host, next.refresh_token as string)).status).toBe(400);
  });

  test("stopping every agent refuses the host's access token, on the API and on MCP, and its refresh token", async () => {
    const host = await registerHost();
    const user = await newUser();
    const tokens = await grant(host, user);
    expect((await ask(tokens.access_token)).status).toBe(201);
    expect((await mcpPost(tokens.access_token)).status).toBe(200);

    const stop = await app.request("/v1/agents/stop", {
      method: "POST",
      headers: { cookie: user.headers.get("cookie") ?? "", "idempotency-key": ulid() },
    });
    expect(stop.status).toBe(200);

    const refused = await ask(tokens.access_token);
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toContain("invalid_token");
    const mcp = await mcpPost(tokens.access_token);
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("www-authenticate")).toContain("invalid_token");
    expect((await refresh(host, tokens.refresh_token as string)).status).toBe(400);
  });
});

test("the consent page shows the cap on Keelson's bond for the host's tier, and refuses spending over it", async () => {
  const UNKNOWN = "https://unknown-host.example/oauth/callback";
  const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
  const unknownHost = await registerHost(UNKNOWN);
  const claudeHost = await registerHost(CLAUDE);
  const user = await newUser();
  const consentFor = async (totalMinor: number, redirect = UNKNOWN) => {
    const host = redirect === UNKNOWN ? unknownHost : claudeHost;
    const { challenge } = pkce();
    const res = await app.request(
      `/api/auth/oauth2/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: host,
        redirect_uri: redirect,
        resource: apiAudience,
        state: "s1",
        code_challenge: challenge,
        code_challenge_method: "S256",
        authorization_details: JSON.stringify([
          {
            type: "keelson_mandate",
            name: "Some host",
            reason: REASON,
            limits: {
              currency: "USD",
              perPurchaseMinor: 5_000,
              totalMinor,
              merchants: ["mrc_runfast"],
              until: new Date(Date.now() + 86_400_000).toISOString(),
            },
          },
        ]),
      })}`,
      { headers: user.headers },
    );
    const oauthQuery = new URL(res.headers.get("location") ?? "").search.slice(1);
    return (path: string) =>
      app.request(path, {
        method: "POST",
        headers: {
          cookie: user.headers.get("cookie") ?? "",
          "content-type": "application/json",
          "idempotency-key": ulid(),
        },
        body: JSON.stringify({ oauthQuery }),
      });
  };
  const within = await consentFor(30_000);
  expect(await (await within("/v1/oauth/consent")).json()).toMatchObject({
    agent: { hosted: true },
    hostedCap: { perUserMinor: "30000", currency: "USD", knownHost: false },
    spendingError: null,
  });
  const over = await consentFor(30_001);
  expect(await (await over("/v1/oauth/consent")).json()).toMatchObject({
    hostedCap: { perUserMinor: "30000" },
    spending: null,
    spendingError: expect.stringContaining("$300.00"),
  });
  expect((await over("/v1/oauth/consent/connection")).status).toBe(422);
  // A known host is capped too, at the higher tier.
  const known = await consentFor(60_000, CLAUDE);
  expect(await (await known("/v1/oauth/consent")).json()).toMatchObject({
    hostedCap: { perUserMinor: "60000", currency: "USD", knownHost: true },
    spendingError: null,
  });
  const knownOver = await consentFor(60_001, CLAUDE);
  expect(await (await knownOver("/v1/oauth/consent")).json()).toMatchObject({
    spending: null,
    spendingError: expect.stringContaining("$600.00"),
  });
});

test("disconnecting one host refuses its access and refresh tokens, on the API and on MCP; another host of the user keeps working", async () => {
  const user = await newUser();
  const [one, two] = [await registerHost(), await registerHost()];
  const [t1, t2] = [await grant(one, user), await grant(two, user)];
  expect((await ask(t1.access_token)).status).toBe(201);
  expect((await ask(t2.access_token)).status).toBe(201);

  const off = await app.request(`/v1/agents/${HOSTED}/disconnect?client=${one}`, {
    method: "POST",
    headers: { cookie: user.headers.get("cookie") ?? "", "idempotency-key": ulid() },
  });
  expect(off.status).toBe(200);

  const refused = await ask(t1.access_token);
  expect(refused.status).toBe(401);
  expect((await mcpPost(t1.access_token)).status).toBe(401);
  expect((await refresh(one, t1.refresh_token as string)).status).toBe(400);

  expect((await ask(t2.access_token)).status).toBe(201);
  expect((await mcpPost(t2.access_token)).status).toBe(200);
  expect((await refresh(two, t2.refresh_token as string)).status).toBe(200);
});

describe("when revocations cannot be read", () => {
  // A real pool to a port nothing listens on: every query fails at once, as with Postgres down.
  const down = createDb("postgres://postgres:keelson@127.0.0.1:9/keelson");
  afterAll(() => down.pool.end());
  const appWith = (db: Db, revocations: Db) =>
    createApp({
      db,
      kv: testKv,
      log: pino({ level: "silent" }),
      auth,
      appOrigin: baseURL,
      authBaseUrl: baseURL,
      authenticate: authenticate(auth, baseURL, revocations),
      demoAgentId: HOSTED,
    });

  test("a host's access token is refused on the API", async () => {
    const { access_token } = await grant(await registerHost(), await newUser());
    const res = await appWith(testDb, down.db).request(
      "/v1/connections",
      bearer(access_token, { name: "Claude", reason: REASON, limits: { currency: "USD" } }),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(await res.json()).toMatchObject({
      type: expect.stringContaining("revocation-unavailable"),
    });
  });

  test("and on MCP", async () => {
    const { access_token } = await grant(await registerHost(), await newUser());
    const call = (to: OpenAPIHono) =>
      to.request("/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${access_token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          host: new URL(baseURL).host,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    expect((await call(appWith(down.db, down.db))).status).toBe(503);
    // Unreadable between the API's check and MCP's own, the token is refused there too.
    const late = await call(appWith(down.db, testDb));
    expect(late.status).toBe(500);
    expect(await late.json()).toMatchObject({
      error: "server_error",
      error_description: expect.stringContaining("cannot be checked"),
    });
  });
});
