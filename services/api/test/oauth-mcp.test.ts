import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { serve } from "@hono/node-server";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { agentConnections, eq, operators } from "@keelson/db";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { apiAudience, createAuth } from "../src/auth.ts";
import { authenticate } from "../src/middleware/auth.ts";
import { testAuthEnv, testDb, testKv } from "./setup.ts";

const secret = randomBytes(32).toString("base64url");
let app!: OpenAPIHono;
const server = serve({ fetch: (req) => app.fetch(req), port: 0, hostname: "127.0.0.1" });
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const appOrigin = "http://app.localhost:3000";

const auth = createAuth(testDb, { ...testAuthEnv(baseURL, secret), APP_ORIGIN: appOrigin });
app = createApp({
  db: testDb,
  kv: testKv,
  log: pino({ level: "silent" }),
  auth,
  appOrigin,
  authBaseUrl: baseURL,
  authenticate: authenticate(auth, baseURL),
});

const helpers = betterAuth({
  database: drizzleAdapter(testDb, { provider: "pg" }),
  secret,
  baseURL,
  plugins: [testUtils()],
});

let userHeaders!: Headers;
beforeAll(async () => {
  const { test: utils } = await helpers.$context;
  const user = await utils.saveUser(utils.createUser());
  userHeaders = await utils.getAuthHeaders({ userId: user.id });
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const REDIRECT = "http://127.0.0.1:33418/callback";
const REASON =
  "I am the Inspector agent, buying the running shoes you asked for in this chat. I only check out at RunFast and only what you named.";

async function register(body: Record<string, unknown>) {
  return app.request("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Inspector", ...body }),
  });
}

async function publicClient(): Promise<string> {
  const res = await register({ token_endpoint_auth_method: "none" });
  expect(res.status).toBeLessThan(300);
  const body = (await res.json()) as { client_id: string; client_secret?: string };
  expect(body.client_secret).toBeUndefined();
  return body.client_id;
}

const verifier = () => randomBytes(32).toString("base64url");
const challenge = (v: string) => createHash("sha256").update(v).digest("base64url");

async function authorize(params: Record<string, string>) {
  const res = await app.request(
    `/api/auth/oauth2/authorize?${new URLSearchParams({
      response_type: "code",
      redirect_uri: REDIRECT,
      scope: "alibis:read",
      resource: apiAudience,
      state: "s1",
      ...params,
    })}`,
    { headers: userHeaders },
  );
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location") ?? "");
}

const consentRead = (oauthQuery: string) =>
  app.request("/v1/oauth/consent", {
    method: "POST",
    headers: {
      cookie: userHeaders.get("cookie") ?? "",
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify({ oauthQuery }),
  });

describe("MCP authorization (OAuth 2.1, RFC 7591, RFC 7636, RFC 9728, RFC 9396)", () => {
  test("the protected resource names its authorization server, which advertises what MCP needs", async () => {
    const prm = await (await app.request("/.well-known/oauth-protected-resource")).json();
    expect(prm).toMatchObject({
      resource: apiAudience,
      authorization_servers: [`${baseURL}/api/auth`],
    });
    const as = await (await app.request("/.well-known/oauth-authorization-server/api/auth")).json();
    expect(as).toMatchObject({
      issuer: `${baseURL}/api/auth`,
      registration_endpoint: `${baseURL}/api/auth/oauth2/register`,
      code_challenge_methods_supported: ["S256"],
    });
    expect(as.grant_types_supported).toEqual(
      expect.arrayContaining(["authorization_code", "client_credentials", "refresh_token"]),
    );
  });

  test("anyone may register a public client; a confidential one needs an admin", async () => {
    await publicClient();
    const confidential = await register({ token_endpoint_auth_method: "client_secret_basic" });
    expect(confidential.status).toBe(400);
    const greedy = await register({
      token_endpoint_auth_method: "none",
      scope: "countersign:write",
    });
    expect(greedy.status).toBe(400);
  });

  test("PKCE is required, and only S256", async () => {
    const id = await publicClient();
    const none = await authorize({ client_id: id });
    expect(none.searchParams.get("error")).toBe("invalid_request");
    const plain = await authorize({
      client_id: id,
      code_challenge: verifier(),
      code_challenge_method: "plain",
    });
    expect(plain.searchParams.get("error")).toBe("invalid_request");
  });

  test("an unverified client reaches the consent page, and a wrong verifier redeems nothing", async () => {
    const id = await publicClient();
    const v = verifier();
    const consent = await authorize({
      client_id: id,
      code_challenge: challenge(v),
      code_challenge_method: "S256",
    });
    expect(consent.origin + consent.pathname).toBe(`${appOrigin}/consent`);
    const oauthQuery = consent.search.slice(1);

    const read = await consentRead(oauthQuery);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      client: { id, name: "Inspector", verified: false },
      agent: null,
      scopes: ["alibis:read"],
      spending: null,
      spendingError: null,
    });
    const tampered = new URLSearchParams(oauthQuery);
    tampered.set("scope", "alibis:read countersign:write");
    expect((await consentRead(tampered.toString())).status).toBe(400);

    const accepted = await app.request("/api/auth/oauth2/consent", {
      method: "POST",
      headers: { cookie: userHeaders.get("cookie") ?? "", "content-type": "application/json" },
      body: JSON.stringify({ accept: true, oauth_query: oauthQuery }),
    });
    expect(accepted.status).toBe(200);
    const { url } = (await accepted.json()) as { url: string };
    const code = new URL(url).searchParams.get("code") ?? "";
    const exchange = (code_verifier: string) =>
      app.request("/api/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT,
          client_id: id,
          code_verifier,
          resource: apiAudience,
        }),
      });
    const wrong = await exchange(verifier());
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toMatch(/^invalid_(grant|request)$/);
    // The code was spent by the attempt with the wrong verifier (RFC 6749 §4.1.2: single use).
    expect((await exchange(v)).status).toBeGreaterThanOrEqual(400);
  });

  test("the right verifier redeems the code for a token the API accepts, with the user's grant only", async () => {
    const id = await publicClient();
    const v = verifier();
    const consent = await authorize({
      client_id: id,
      code_challenge: challenge(v),
      code_challenge_method: "S256",
    });
    const accepted = await app.request("/api/auth/oauth2/consent", {
      method: "POST",
      headers: { cookie: userHeaders.get("cookie") ?? "", "content-type": "application/json" },
      body: JSON.stringify({ accept: true, oauth_query: consent.search.slice(1) }),
    });
    const code = new URL(((await accepted.json()) as { url: string }).url).searchParams.get("code");
    const token = await app.request("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        redirect_uri: REDIRECT,
        client_id: id,
        code_verifier: v,
        resource: apiAudience,
      }),
    });
    expect(token.status).toBe(200);
    const body = (await token.json()) as { access_token: string; scope: string };
    expect(body.scope).toBe("alibis:read");
    const ask = await app.request("/v1/connections", {
      method: "POST",
      headers: {
        authorization: `Bearer ${body.access_token}`,
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({}),
    });
    expect(ask.status).toBe(403);
  });

  test("spending limits ride in authorization_details, and only a client linked to an operator gets them", async () => {
    const id = await publicClient();
    const details = JSON.stringify([
      {
        type: "keelson_mandate",
        name: "Inspector",
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
    const params = {
      client_id: id,
      code_challenge: challenge(verifier()),
      code_challenge_method: "S256",
      authorization_details: details,
    };
    const unlinked = await consentRead((await authorize(params)).search.slice(1));
    expect(await unlinked.json()).toMatchObject({
      spending: null,
      spendingError: expect.stringContaining("No registered agent operator"),
    });

    const agentId = BigInt(`0x${randomBytes(10).toString("hex")}`);
    await testDb.insert(operators).values({
      agentId,
      chainId: 421614,
      agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
      name: "Inspector Labs",
      cnfJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
      clientId: id,
    });
    const oauthQuery = (await authorize(params)).search.slice(1);
    const linked = await consentRead(oauthQuery);
    expect(await linked.json()).toMatchObject({
      client: { verified: true },
      agent: { agentId: agentId.toString(), operator: "Inspector Labs" },
      spending: { name: "Inspector", reason: REASON, limits: { perPurchaseMinor: 5_000 } },
      spendingError: null,
    });
    const asked = await app.request("/v1/oauth/consent/connection", {
      method: "POST",
      headers: {
        cookie: userHeaders.get("cookie") ?? "",
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({ oauthQuery }),
    });
    expect(asked.status).toBe(201);
    const { userCode } = (await asked.json()) as { userCode: string };
    const [row] = await testDb
      .select()
      .from(agentConnections)
      .where(eq(agentConnections.userCode, userCode));
    expect(row).toMatchObject({
      kind: "connect",
      clientId: id,
      operatorAgentId: agentId,
      state: "PENDING",
      perPurchaseMinor: 5_000n,
    });
  });
});
