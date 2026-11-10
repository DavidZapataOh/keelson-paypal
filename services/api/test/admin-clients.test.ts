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
import { authenticate } from "../src/middleware/auth.ts";
import { testAuthEnv, testDb, testKv } from "./setup.ts";

const secret = randomBytes(32).toString("base64url");
let app!: OpenAPIHono;

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
): Promise<Response> {
  const res = await app.request("/api/auth/oauth2/token", {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials", ...params }),
  });
  return res;
}

const SCOPES = ["countersign:write", "evidence:write", "operators:write"];
const path = (id: string) => `/v1/admin/oauth-clients/${id}/client-credentials-scopes`;
const set = (id: string, headers: HeadersInit, scopes: unknown = SCOPES) =>
  app.request(path(id), {
    method: "POST",
    headers: {
      ...Object.fromEntries(new Headers(headers)),
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify({ scopes }),
  });

test("a client registered without client credentials scopes gets no token", async () => {
  const client = await registerClient([]);
  expect((await issueToken(client)).status).toBe(400);
});

test("only a signed-in admin sets a client's client credentials scopes", async () => {
  const client = await registerClient([]);
  expect((await set(client.id, {})).status).toBe(401);
  expect((await set(client.id, userHeaders)).status).toBe(403);
  const other = await registerClient(["operators:write"]);
  const token = await (await issueToken(other)).json();
  const res = await set(client.id, { authorization: `Bearer ${token.access_token}` });
  expect(res.status).toBe(401);
});

test("scopes outside the provider's are refused", async () => {
  const client = await registerClient([]);
  expect((await set(client.id, sessionHeaders, ["root"])).status).toBe(422);
  expect((await set(client.id, sessionHeaders, [])).status).toBe(422);
});

test("an unknown client is not found", async () => {
  expect((await set("no-such-client", sessionHeaders)).status).toBe(404);
});

test("an admin's scopes let the client get a token for the API", async () => {
  const client = await registerClient([]);
  const res = await set(client.id, sessionHeaders);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ clientId: client.id, scopes: SCOPES });
  const token = await issueToken(client, { resource: apiAudience, scope: SCOPES.join(" ") });
  expect(token.status).toBe(200);
  expect((await token.json()).scope.split(" ").sort()).toEqual([...SCOPES].sort());
});
