import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { serve } from "@hono/node-server";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { sql, user as users } from "@keelson/db";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { pino } from "pino";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { apiAudience, createAuth } from "../src/auth.ts";
import { authenticate, requireClient, requireSession } from "../src/middleware/auth.ts";
import { testAuthEnv, testDb, testKv } from "./setup.ts";

const secret = randomBytes(32).toString("base64url");
let app!: OpenAPIHono;
let echoes = 0;

const server = serve({ fetch: (req) => app.fetch(req), port: 0, hostname: "127.0.0.1" });
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const auth = createAuth(testDb, testAuthEnv(baseURL, secret));
app = createApp({
  db: testDb,
  kv: testKv,
  log: pino({ level: "silent" }),
  auth,
  authenticate: authenticate(auth, baseURL),
});
app.get("/v1/test/alibis", requireClient(["alibis:read"]), (c) => c.json(c.var.principal));
app.get("/v1/test/disputes", requireClient(["disputes:read"]), (c) => c.json({ ok: true }));
app.get("/v1/test/me", requireSession(), (c) => c.json(c.var.principal));
app.post("/v1/test/echo", requireClient(["alibis:read"]), (c) => {
  echoes += 1;
  return c.json({ n: echoes, client: c.var.principal?.subject });
});

const helpers = betterAuth({
  database: drizzleAdapter(testDb, { provider: "pg" }),
  secret,
  baseURL,
  plugins: [testUtils()],
});

let sessionHeaders!: Headers;
let userHeaders!: Headers;

beforeAll(async () => {
  const { test: utils } = await helpers.$context;
  const admin = await utils.saveUser(utils.createUser());
  await testDb.update(users).set({ role: "admin" }).where(sql`${users.id} = ${admin.id}`);
  sessionHeaders = await utils.getAuthHeaders({ userId: admin.id });
  const user = await utils.saveUser(utils.createUser());
  userHeaders = await utils.getAuthHeaders({ userId: user.id });
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function registerClient(scopes: string[]): Promise<{ id: string; secret: string }> {
  const client = await auth.api.adminCreateOAuthClient({
    headers: sessionHeaders,
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

async function issueToken(
  client: { id: string; secret: string },
  params: Record<string, string> = { resource: apiAudience },
): Promise<string> {
  const res = await app.request("/api/auth/oauth2/token", {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials", ...params }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.token_type).toBe("Bearer");
  return body.access_token;
}

const resourceMetadata = `${baseURL}/.well-known/oauth-protected-resource`;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function expectInvalidToken(res: Response): Promise<void> {
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toBe(
    `Bearer resource_metadata="${resourceMetadata}", error="invalid_token"`,
  );
  expect((await res.json()).type).toBe("https://api.keelson.finance/problems/invalid-token");
}

test("a client credentials token passes a route that needs its scope", async () => {
  const client = await registerClient(["alibis:read"]);
  const token = await issueToken(client);
  const res = await app.request("/v1/test/alibis", { headers: bearer(token) });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ kind: "client", subject: client.id, scopes: ["alibis:read"] });
});

test("a token without the scope gets 403 insufficient-scope", async () => {
  const token = await issueToken(await registerClient(["alibis:read"]));
  const res = await app.request("/v1/test/disputes", { headers: bearer(token) });
  expect(res.status).toBe(403);
  expect(res.headers.get("content-type")).toBe("application/problem+json");
  expect((await res.json()).type).toBe("https://api.keelson.finance/problems/insufficient-scope");
  expect(res.headers.get("www-authenticate")).toBe(
    `Bearer resource_metadata="${resourceMetadata}", error="insufficient_scope", scope="disputes:read"`,
  );
});

test("a request without a token gets 401 with a bearer challenge", async () => {
  const res = await app.request("/v1/test/alibis");
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${resourceMetadata}"`);
  expect((await res.json()).type).toBe("https://api.keelson.finance/problems/unauthorized");
});

test("a tampered token gets 401", async () => {
  const token = await issueToken(await registerClient(["alibis:read"]));
  const [header, payload, signature] = token.split(".") as [string, string, string];
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  claims.scope = "alibis:read disputes:read";
  const forged = `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
  await expectInvalidToken(await app.request("/v1/test/disputes", { headers: bearer(forged) }));
});

test("an invalid bearer token is rejected even next to a valid session cookie", async () => {
  for (const path of ["/v1/test/alibis", "/v1/test/me"]) {
    const headers = new Headers(sessionHeaders);
    headers.set("authorization", "Bearer a.b.c");
    await expectInvalidToken(await app.request(path, { headers }));
  }
});

test("a JWT signed with our key that is not an access token gets 401", async () => {
  const client = await registerClient(["alibis:read"]);
  const { token } = await auth.api.signJWT({
    body: {
      payload: {
        iss: `${baseURL}/api/auth`,
        aud: apiAudience,
        azp: client.id,
        scope: "alibis:read",
      },
    },
  });
  await expectInvalidToken(await app.request("/v1/test/alibis", { headers: bearer(token) }));
});

test("an opaque token minted without a resource gets 401", async () => {
  const token = await issueToken(await registerClient(["alibis:read"]), {});
  expect(token.split(".")).toHaveLength(1);
  await expectInvalidToken(await app.request("/v1/test/alibis", { headers: bearer(token) }));
});

test("a session principal is a user and cannot use client routes", async () => {
  const me = await app.request("/v1/test/me", { headers: sessionHeaders });
  expect(me.status).toBe(200);
  expect((await me.json()).kind).toBe("user");
  const res = await app.request("/v1/test/alibis", { headers: sessionHeaders });
  expect(res.status).toBe(403);
  expect((await res.json()).type).toBe("https://api.keelson.finance/problems/insufficient-scope");
});

test("a session route without a session gets 401", async () => {
  const res = await app.request("/v1/test/me");
  expect(res.status).toBe(401);
  expect((await res.json()).type).toBe("https://api.keelson.finance/problems/unauthorized");
});

test("two clients sending the same idempotency key do not collide", async () => {
  const a = await registerClient(["alibis:read"]);
  const b = await registerClient(["alibis:read"]);
  const [tokenA, tokenB] = await Promise.all([issueToken(a), issueToken(b)]);
  const key = `k-${crypto.randomUUID()}`;
  const post = (token: string) =>
    app.request("/v1/test/echo", {
      method: "POST",
      headers: { ...bearer(token), "idempotency-key": key, "content-type": "application/json" },
      body: "{}",
    });
  const first = await post(tokenA);
  const second = await post(tokenB);
  const replay = await post(tokenA);
  expect((await first.json()).client).toBe(a.id);
  expect(second.headers.get("idempotent-replayed")).toBeNull();
  expect((await second.json()).client).toBe(b.id);
  expect(replay.headers.get("idempotent-replayed")).toBe("true");
  expect((await replay.json()).client).toBe(a.id);
});

test("a signed-in user who is not an admin cannot create or manage OAuth clients", async () => {
  const { id: clientId } = await registerClient(["alibis:read"]);
  const routes: [method: "GET" | "POST", path: string, body?: object][] = [
    ["POST", "/oauth2/create-client", { redirect_uris: ["https://rogue.example/callback"] }],
    ["GET", "/oauth2/get-clients"],
    ["GET", `/oauth2/get-client?client_id=${clientId}`],
    ["POST", "/oauth2/update-client", { client_id: clientId, update: { client_name: "Rogue" } }],
    ["POST", "/oauth2/client/rotate-secret", { client_id: clientId }],
    ["POST", "/oauth2/delete-client", { client_id: clientId }],
  ];
  const send = (headers: Headers, [method, path, body]: (typeof routes)[number]) =>
    app.request(`/api/auth${path}`, {
      method,
      headers: {
        cookie: headers.get("cookie") as string,
        origin: baseURL,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  for (const route of routes) {
    expect((await send(userHeaders, route)).status, route[1]).toBe(401);
  }
  expect((await send(sessionHeaders, routes[2] as (typeof routes)[number])).status).toBe(200);
  await expect(
    auth.api.adminCreateOAuthClient({
      headers: userHeaders,
      body: {
        client_name: "Rogue agent",
        token_endpoint_auth_method: "client_secret_basic",
        grant_types: ["client_credentials"],
        client_credentials_scopes: ["operators:write"],
        resources: [apiAudience],
      },
    }),
  ).rejects.toMatchObject({ statusCode: 401 });
});

test.skipIf(!process.env.PAYPAL_CLIENT_ID)(
  "sign in with PayPal starts at the sandbox authorize endpoint with our callback",
  async () => {
    const res = await app.request("/api/auth/sign-in/social", {
      method: "POST",
      headers: { origin: baseURL, "content-type": "application/json" },
      body: JSON.stringify({ provider: "paypal" }),
    });
    expect(res.status).toBe(200);
    const url = new URL((await res.json()).url);
    expect(`${url.origin}${url.pathname}`).toBe("https://www.sandbox.paypal.com/signin/authorize");
    expect(url.searchParams.get("client_id")).toBe(process.env.PAYPAL_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(`${baseURL}/api/auth/callback/paypal`);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(
      "openid email profile https://uri.paypal.com/services/paypalattributes",
    );
    expect(res.headers.get("set-cookie")).toContain("state");
  },
);

/** A PayPal `userinfo?schema=paypalv1.1` response, as returned by the sandbox, with values redacted. */
const paypalUserInfo = {
  user_id: "https://www.paypal.com/webapps/auth/identity/user/REDACTED",
  sub: "https://www.paypal.com/webapps/auth/identity/user/REDACTED",
  name: "Sandbox Buyer",
  payer_id: "REDACTEDPAYER",
  verified_account: "true",
  emails: [
    { value: "secondary@example.com", primary: false, confirmed: true },
    { value: "buyer@example.com", primary: true, confirmed: true },
  ],
};

test("a PayPal profile signs in with its primary confirmed email", async () => {
  const toUser = auth.options.socialProviders.paypal.mapProfileToUser;
  expect(await toUser?.(paypalUserInfo as never)).toEqual({
    email: "buyer@example.com",
    emailVerified: true,
  });
  const unconfirmed = {
    ...paypalUserInfo,
    emails: [{ value: "buyer@example.com", primary: true, confirmed: false }],
  };
  expect(await toUser?.(unconfirmed as never)).toEqual({});
});
