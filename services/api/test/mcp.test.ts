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
    "keelson.await_approval",
    "keelson.compile_mandate",
    "keelson.confirm_mandate",
    "keelson.get_alibi",
    "keelson.get_trust_grade",
    "keelson.request_mandate",
    "keelson.submit_evidence",
    "keelson.verify_alibi",
  ]);
  for (const tool of tools) expect(tool.outputSchema?.type).toBe("object");
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
  expect(result.structuredContent).toEqual({
    status: "signing",
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
    status: "ready",
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
  const waiting = asked.structuredContent as {
    userCode: string;
    url: string;
    deviceCode: string;
    card: { title: string; action: string; url: string };
  };
  expect(waiting.card).toEqual({
    title: "Claude Code wants to spend up to $50.00",
    amount: "$50.00",
    action: "Review",
    url: waiting.url,
  });
  expect(waiting.url).toMatch(/\/connect\?c=[A-Z]{4}-[A-Z]{4}$/);

  const poll = () =>
    client.callTool({
      name: "keelson.await_approval",
      arguments: { deviceCode: waiting.deviceCode },
    });
  expect((await poll()).structuredContent).toMatchObject({ status: "pending", mandateId: null });
  await testDb
    .update(agentConnections)
    .set({ state: "DENIED", decidedAt: new Date() })
    .where(eq(agentConnections.userCode, waiting.userCode));
  expect((await poll()).structuredContent).toMatchObject({ status: "denied" });
  await client.close();
});
