import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { serve } from "@hono/node-server";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { pino } from "pino";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { apiAudience, createAuth } from "../src/auth.ts";
import { authenticate, requireClient, requireSession } from "../src/middleware/auth.ts";
import { testDb, testKv } from "./setup.ts";

const secret = randomBytes(32).toString("base64url");
let app!: OpenAPIHono;
let echoes = 0;

const server = serve({ fetch: (req) => app.fetch(req), port: 0, hostname: "127.0.0.1" });
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const auth = createAuth(testDb, { BETTER_AUTH_SECRET: secret, BETTER_AUTH_URL: baseURL });
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

beforeAll(async () => {
  const { test: utils } = await helpers.$context;
  const user = await utils.saveUser(utils.createUser());
  sessionHeaders = await utils.getAuthHeaders({ userId: user.id });
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

async function issueToken(client: { id: string; secret: string }): Promise<string> {
  const res = await app.request("/api/auth/oauth2/token", {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials", resource: apiAudience }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.token_type).toBe("Bearer");
  return body.access_token;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

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
  expect(res.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
});

test("a request without a token gets 401 with a bearer challenge", async () => {
  const res = await app.request("/v1/test/alibis");
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
  expect((await res.json()).type).toBe("https://api.keelson.finance/problems/unauthorized");
});

test("a tampered token gets 401", async () => {
  const token = await issueToken(await registerClient(["alibis:read"]));
  const [header, payload, signature] = token.split(".") as [string, string, string];
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  claims.scope = "alibis:read disputes:read";
  const forged = `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
  const res = await app.request("/v1/test/disputes", { headers: bearer(forged) });
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
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
