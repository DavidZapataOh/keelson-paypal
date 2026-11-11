import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { serve } from "@hono/node-server";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { leafHashOf } from "@keelson/alibi";
import {
  agentConnections,
  alibis,
  eq,
  evidenceBundles,
  mandates,
  operators,
  purchases,
  sql,
  user as users,
} from "@keelson/db";
import { ALIBI_VIEW_URI } from "@keelson/mcp";
import {
  Client,
  ClientCredentialsProvider,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { pino } from "pino";
import { ulid } from "ulid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { fixtures } from "../../../packages/alibi/test/fixtures.ts";
import { createApp } from "../src/app.ts";
import { apiAudience, createAuth } from "../src/auth.ts";
import { authenticate } from "../src/middleware/auth.ts";
import { testAuthEnv, testDb, testKv } from "./setup.ts";

const secret = randomBytes(32).toString("base64url");
let app!: OpenAPIHono;
const server = serve({ fetch: (req) => app.fetch(req), port: 0, hostname: "127.0.0.1" });
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const issuer = `${baseURL}/api/auth`;
const mcpUrl = new URL("/mcp", baseURL);

const auth = createAuth(testDb, testAuthEnv(baseURL, secret));
app = createApp({
  db: testDb,
  kv: testKv,
  log: pino({ level: "silent" }),
  auth,
  authenticate: authenticate(auth, baseURL),
  authBaseUrl: baseURL,
});

const helpers = betterAuth({
  database: drizzleAdapter(testDb, { provider: "pg" }),
  secret,
  baseURL,
  plugins: [testUtils()],
});
let adminHeaders!: Headers;

beforeAll(async () => {
  const { test: utils } = await helpers.$context;
  const admin = await utils.saveUser(utils.createUser());
  await testDb.update(users).set({ role: "admin" }).where(sql`${users.id} = ${admin.id}`);
  adminHeaders = await utils.getAuthHeaders({ userId: admin.id });
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function registerClient(scopes: string[]): Promise<{ id: string; secret: string }> {
  const client = await auth.api.adminCreateOAuthClient({
    headers: adminHeaders,
    body: {
      client_name: "Test agent",
      token_endpoint_auth_method: "client_secret_basic",
      grant_types: ["client_credentials"],
      client_credentials_scopes: scopes,
      resources: [apiAudience],
    },
  });
  return { id: client.client_id, secret: client.client_secret as string };
}

/**
 * The API's resource identifier is its production origin, so the client connects there and this
 * fetch reaches the test server in its place, as DNS would.
 */
const viaTestServer: typeof fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== apiAudience) return fetch(input, init);
  return fetch(new URL(`${url.pathname}${url.search}`, baseURL), init);
};

/** An MCP client that finds the authorization server from the 401 and gets its own token. */
async function connect(
  scopes: string[],
  creds: { id: string; secret: string } | undefined = undefined,
): Promise<Client> {
  creds ??= await registerClient(scopes);
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", apiAudience), {
      fetch: viaTestServer,
      authProvider: new ClientCredentialsProvider({
        clientId: creds.id,
        clientSecret: creds.secret,
        scope: scopes.join(" "),
        expectedIssuer: issuer,
      }),
    }),
  );
  return client;
}

test("a request without a token is challenged toward the protected resource metadata", async () => {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toContain(
    `resource_metadata="${baseURL}/.well-known/oauth-protected-resource"`,
  );
});

test("the protected resource and its authorization server publish their metadata", async () => {
  const prm = await (await fetch(`${baseURL}/.well-known/oauth-protected-resource`)).json();
  expect(prm).toMatchObject({ resource: apiAudience, authorization_servers: [issuer] });
  const as = await fetch(`${baseURL}/.well-known/oauth-authorization-server/api/auth`);
  expect(as.status).toBe(200);
  const metadata = await as.json();
  expect(metadata.issuer).toBe(issuer);
  expect(metadata.token_endpoint).toBe(`${issuer}/oauth2/token`);
  expect(metadata.grant_types_supported).toContain("client_credentials");
});

test("a client with client credentials lists the tools, each with an output schema", async () => {
  const client = await connect(["alibis:read"]);
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual([
    "keelson.check_cart",
    "keelson.compile_mandate",
    "keelson.confirm_mandate",
    "keelson.export_alibi",
    "keelson.get_alibi",
    "keelson.get_purchase",
    "keelson.get_request",
    "keelson.get_trust_grade",
    "keelson.request_mandate",
    "keelson.request_mandate_change",
    "keelson.submit_evidence",
    "keelson.verify_alibi",
  ]);
  for (const tool of tools) expect(tool.outputSchema?.type).toBe("object");
  // Every tool that starts something says it is never called again to finish it.
  for (const name of [
    "keelson.request_mandate",
    "keelson.request_mandate_change",
    "keelson.submit_evidence",
  ]) {
    expect(tools.find((t) => t.name === name)?.description).toContain("Never call this tool again");
  }
  const card = tools.find((t) => t.name === "keelson.get_alibi");
  expect((card?._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri).toBe(
    ALIBI_VIEW_URI,
  );
  await client.close();
});

test("the Alibi View is served as an MCP App resource", async () => {
  const client = await connect(["alibis:read"]);
  const { contents } = await client.readResource({ uri: ALIBI_VIEW_URI });
  expect(contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
  expect((contents[0] as { text: string }).text).toContain('<main id="alibi"');
  const policy = await client.readResource({ uri: "keelson://policy" });
  expect((policy.contents[0] as { text: string }).text).toContain("permit");
  await client.close();
});

test("compiling hands the request to the user's app when the client opens no URLs", async () => {
  const client = await connect(["alibis:read"]);
  const result = await client.callTool({
    name: "keelson.compile_mandate",
    arguments: { request: "Trail Runner 2, size 10, under $150" },
  });
  expect(result.structuredContent).toMatchObject({
    status: "pending_approval",
    next: { action: "show_user_then_poll", tool: "keelson.confirm_mandate" },
    url: "https://app.keelson.finance/new?request=Trail+Runner+2%2C+size+10%2C+under+%24150",
  });
  await client.close();
});

test("a tool whose scope the token lacks is challenged for it before it runs", async () => {
  const creds = await registerClient(["alibis:read"]);
  const token = await fetch(`${issuer}/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${creds.id}:${creds.secret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials", resource: apiAudience }),
  }).then(async (r) => ((await r.json()) as { access_token: string }).access_token);
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "keelson.submit_evidence",
        arguments: {
          mandateId: "01M725QRZRY5EP9QQQCKMF3MQC",
          lines: [
            {
              productUrl: "https://store.keelson.finance/products/trail-runner-2",
              size: "10",
              qty: 1,
            },
          ],
          observation: "Trail Runner 2, $139",
        },
      },
    }),
  });
  expect(res.status).toBe(403);
  const challenge = res.headers.get("www-authenticate") ?? "";
  expect(challenge).toContain('error="insufficient_scope"');
  expect(challenge).toContain('scope="evidence:write"');
});

test("an Alibi the client may not read is a tool error, not a protocol error", async () => {
  const client = await connect(["alibis:read"]);
  const result = await client.callTool({
    name: "keelson.get_alibi",
    arguments: { purchaseId: "01M725SRGK6SS7HEXN1K572KJY" },
  });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("Not found");
  await client.close();
});

test("the trust grade of an operator that is not linked is a tool error", async () => {
  const client = await connect(["alibis:read"]);
  const result = await client.callTool({
    name: "keelson.get_trust_grade",
    arguments: { agentId: "1" },
  });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("operator-not-found");
  await client.close();
});

test("a browser page on another origin is refused", async () => {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: "{}",
  });
  expect(res.status).toBe(403);
});

test("confirming finds the held mandate of the operator the client linked, through the API", async () => {
  const creds = await registerClient(["countersign:write"]);
  const agentId = 9_100_000_000n + BigInt(randomBytes(3).readUIntBE(0, 3));
  const sub = `kls_usr_${randomBytes(8).toString("hex")}`;
  const id = ulid();
  await testDb.insert(operators).values({
    agentId,
    chainId: 421614,
    agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
    name: "Linked",
    cnfJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    clientId: creds.id,
  });
  await testDb.insert(users).values({ id: sub, name: "Tester", email: `${sub}@example.test` });
  await testDb.insert(mandates).values({
    id,
    userId: sub,
    currency: "USD",
    maxMinor: 15_000n,
    remainingMinor: 15_000n,
    merchantIds: ["mrc_runfast"],
    expiresAt: new Date(Date.now() + 86_400_000),
    operatorAgentId: agentId,
    state: "ACTIVE",
    openMandate: "open~active~",
    holdMode: "mandate",
    paypalAuthorizationId: `AUTH${randomBytes(6).toString("hex").toUpperCase()}`,
  });
  const client = await connect(["countersign:write"], creds);
  const result = await client.callTool({
    name: "keelson.confirm_mandate",
    arguments: { agentId: agentId.toString() },
  });
  expect(result.structuredContent).toMatchObject({
    status: "success",
    next: { action: "call", tool: "keelson.submit_evidence", arguments: { mandateId: id } },
    mandate: { id, currency: "USD", remainingMinor: 15_000, holdMode: "mandate", held: true },
  });
  const other = await connect(["countersign:write"]);
  const refused = await other.callTool({
    name: "keelson.confirm_mandate",
    arguments: { agentId: agentId.toString() },
  });
  expect(refused.isError).toBe(true);
  await client.close();
  await other.close();
});

test.skipIf(!fixtures[0])("verifying an Alibi returns the API verifier's report", async () => {
  const b = fixtures[0]?.bundle as NonNullable<(typeof fixtures)[0]>["bundle"];
  const c = b.tee.countersign;
  const creds = await registerClient(["alibis:read"]);
  const owner = `kls_usr_${randomBytes(8).toString("hex")}`;
  const mandateId = ulid();
  await testDb.insert(users).values({ id: owner, name: "Tester", email: `${owner}@example.test` });
  await testDb
    .insert(operators)
    .values({
      agentId: BigInt(c.agentId),
      chainId: 421614,
      agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
      name: "op",
      cnfJwk: {},
    })
    .onConflictDoNothing();
  await testDb.insert(mandates).values({
    id: mandateId,
    userId: owner,
    operatorAgentId: BigInt(c.agentId),
    state: "ACTIVE",
    currency: "USD",
    maxMinor: 10_000n,
    remainingMinor: 10_000n,
    merchantIds: ["store"],
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  await testDb.insert(evidenceBundles).values({
    root: Buffer.from(c.evidenceRoot.slice(2), "hex"),
    mandateId,
    manifest: b.manifest.public,
    uploadedBy: creds.id,
  });
  await testDb.insert(purchases).values({
    id: b.alibi_id,
    mandateId,
    clientId: creds.id,
    state: "CAPTURED",
    merchantId: String(b.eval.context.merchant),
    currency: "USD",
    amountMinor: BigInt(c.amount),
    cartHash: Buffer.from(c.cartHash.slice(2), "hex"),
  });
  const { timestamps: _t, anchor: _a, ...core } = b;
  await testDb.insert(alibis).values({
    purchaseId: b.alibi_id,
    leafHash: Buffer.from(leafHashOf(b)),
    bundle: { ...core, timestamps: [], paypal: { ...core.paypal, capture_id: undefined } },
  });

  const client = await connect(["alibis:read"], creds);
  const result = await client.callTool({
    name: "keelson.verify_alibi",
    arguments: { purchaseId: b.alibi_id },
  });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  const report = result.structuredContent as { verdict: string; checks: { id: string }[] };
  expect(report.verdict).toEqual(expect.any(String));
  expect(report.checks.map((x) => x.id)).toContain("tee.countersign");
  await client.close();
});

test("an agent asks its user for a mandate and hears the answer through the tools", async () => {
  const creds = await registerClient(["countersign:write"]);
  await testDb.insert(operators).values({
    agentId: BigInt(`0x${randomBytes(10).toString("hex")}`),
    chainId: 421614,
    agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
    name: "Asking operator",
    cnfJwk: {},
    clientId: creds.id,
  });
  const client = await connect(["countersign:write"], creds);
  const asked = await client.callTool({
    name: "keelson.request_mandate",
    arguments: {
      name: "Claude Code",
      reason:
        "I am Claude Code, buying the running shoes you asked for in this session. I check out at RunFast only and only what you named.",
      perPurchaseMinor: 5_000,
      totalMinor: 5_000,
      until: new Date(Date.now() + 86_400_000).toISOString(),
    },
  });
  expect(asked.isError, JSON.stringify(asked.content)).toBeFalsy();
  // A client that opens no URLs is told to show the link and the number, then poll.
  const waiting = asked.structuredContent as {
    status: string;
    next: { action: string; tool: string; arguments: { requestId: string }; afterSeconds: number };
    requestId: string;
    userCode: string;
    approvalUrl: string;
    matchNumber: number;
    card: { title: string; action: string; url: string };
  };
  expect(waiting).toMatchObject({
    status: "pending_approval",
    next: {
      action: "show_user_then_poll",
      tool: "keelson.get_request",
      arguments: { requestId: waiting.requestId },
      afterSeconds: 5,
    },
  });
  expect(waiting.matchNumber).toBeGreaterThanOrEqual(10);
  expect(waiting.card).toEqual({
    title: "Claude Code wants to spend up to $50.00",
    amount: "$50.00",
    action: "Review",
    url: waiting.approvalUrl,
  });
  expect(waiting.approvalUrl).toMatch(/\/connect\?c=[A-Z]{4}-[A-Z]{4}$/);

  const poll = () =>
    client.callTool({
      name: "keelson.get_request",
      arguments: { requestId: waiting.requestId },
    });
  // Polling changes nothing, however often.
  expect((await poll()).structuredContent).toMatchObject({ status: "pending_approval" });
  expect((await poll()).structuredContent).toMatchObject({ status: "pending_approval" });
  await testDb
    .update(agentConnections)
    .set({ state: "DENIED", decidedAt: new Date() })
    .where(eq(agentConnections.userCode, waiting.userCode));
  expect((await poll()).structuredContent).toMatchObject({
    status: "denied",
    next: { action: "stop" },
  });
  await client.close();
});

/** An operator whose agent's client is `creds`, and a user with a live mandate naming it. */
async function linkedMandate(creds: { id: string }) {
  const agentId = BigInt(`0x${randomBytes(10).toString("hex")}`);
  await testDb.insert(operators).values({
    agentId,
    chainId: 421614,
    agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
    name: "Linked",
    cnfJwk: {},
    clientId: creds.id,
  });
  const sub = `kls_usr_${randomBytes(8).toString("hex")}`;
  await testDb.insert(users).values({ id: sub, name: "Tester", email: `${sub}@example.test` });
  const id = ulid();
  await testDb.insert(mandates).values({
    id,
    userId: sub,
    currency: "USD",
    maxMinor: 15_000n,
    remainingMinor: 15_000n,
    merchantIds: ["mrc_runfast"],
    expiresAt: new Date(Date.now() + 86_400_000),
    operatorAgentId: agentId,
    state: "ACTIVE",
    openMandate: "open~active~",
    holdMode: "mandate",
    paypalAuthorizationId: `AUTH${randomBytes(6).toString("hex").toUpperCase()}`,
  });
  return { agentId, sub, id };
}

test("a host that opens URLs is shown the approval page in the same call, then gets the state", async () => {
  const creds = await registerClient(["countersign:write"]);
  await testDb.insert(operators).values({
    agentId: BigInt(`0x${randomBytes(10).toString("hex")}`),
    chainId: 421614,
    agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
    name: "Asking operator",
    cnfJwk: {},
    clientId: creds.id,
  });
  const scopes = ["countersign:write"];
  const client = new Client(
    { name: "elicit-agent", version: "1.0.0" },
    // The modern protocol carries the client's capabilities on every request, so a stateless
    // server knows it opens URLs.
    { capabilities: { elicitation: { url: {} } }, versionNegotiation: { mode: "auto" } },
  );
  const opened: string[] = [];
  client.setRequestHandler("elicitation/create", async (request) => {
    opened.push((request.params as { url?: string }).url ?? "");
    return { action: "accept" };
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", apiAudience), {
      fetch: viaTestServer,
      authProvider: new ClientCredentialsProvider({
        clientId: creds.id,
        clientSecret: creds.secret,
        scope: scopes.join(" "),
        expectedIssuer: issuer,
      }),
    }),
  );
  const asked = await client.callTool({
    name: "keelson.request_mandate",
    arguments: {
      name: "Claude Code",
      reason:
        "I am Claude Code, buying the running shoes you asked for in this session. I check out at RunFast only and only what you named.",
      perPurchaseMinor: 5_000,
      totalMinor: 5_000,
      until: new Date(Date.now() + 86_400_000).toISOString(),
    },
  });
  expect(asked.isError, JSON.stringify(asked.content)).toBeFalsy();
  expect(opened).toHaveLength(1);
  expect(opened[0]).toMatch(/\/connect\?c=[A-Z]{4}-[A-Z]{4}$/);
  const s = asked.structuredContent as { status: string; approvalUrl: string; requestId: string };
  expect(s.status).toBe("pending_approval");
  expect(s.approvalUrl).toBe(opened[0]);
  // One request for one call, however many rounds it took.
  const rows = await testDb
    .select()
    .from(agentConnections)
    .where(eq(agentConnections.clientId, creds.id));
  expect(rows).toHaveLength(1);
  await client.close();
});

test("an agent checks a cart, asks for more room and polls a purchase, each in the envelope", async () => {
  const creds = await registerClient(["countersign:write"]);
  const { id } = await linkedMandate(creds);
  const client = await connect(["countersign:write"], creds);

  // The test mandate carries no signed payload: the check says what blocks it.
  const checked = await client.callTool({
    name: "keelson.check_cart",
    arguments: {
      mandateId: id,
      cart: {
        merchant: "mrc_runfast",
        currency: "USD",
        lines: [{ sku: "TR2-10", size: "10", category: "shoes", qty: 1, unit_minor: 13_900 }],
        return_days: 30,
        returns_free: true,
      },
    },
  });
  expect(checked.isError, JSON.stringify(checked.content)).toBeFalsy();
  expect(checked.structuredContent).toMatchObject({ next: expect.any(Object) });

  const changed = await client.callTool({
    name: "keelson.request_mandate_change",
    arguments: { mandateId: id, note: "Needs $40 more for shipping", totalMinor: 19_000 },
  });
  // The test mandate is not signed, so it cannot be changed: a tool error in the envelope.
  expect(changed.structuredContent).toMatchObject({ status: "error", retryable: false });

  const purchaseId = ulid();
  await testDb.insert(purchases).values({
    id: purchaseId,
    mandateId: id,
    clientId: creds.id,
    state: "FAILED",
    failureReason: "capture:timeout",
    merchantId: "mrc_runfast",
    currency: "USD",
    amountMinor: 13_900n,
    cartHash: randomBytes(32),
  });
  const got = await client.callTool({ name: "keelson.get_purchase", arguments: { purchaseId } });
  // A capture that failed after it was sent may have moved the money: say so, never retry.
  expect(got.structuredContent).toMatchObject({
    status: "error",
    outcome: "unknown",
    retryable: false,
    next: { action: "poll", tool: "keelson.get_purchase" },
  });
  // Captured, and whatever came after, is done: the agent never buys it again.
  for (const state of ["CAPTURED", "DISPUTED"] as const) {
    await testDb
      .update(purchases)
      .set({ state, failureReason: null })
      .where(eq(purchases.id, purchaseId));
    const done = await client.callTool({ name: "keelson.get_purchase", arguments: { purchaseId } });
    expect(done.structuredContent).toMatchObject({ status: "success", outcome: "known" });
  }
  await client.close();
});
