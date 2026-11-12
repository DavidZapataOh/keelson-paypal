import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { serve } from "@hono/node-server";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { sql, user as users } from "@keelson/db";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { decodeProtectedHeader } from "jose";
import { pino } from "pino";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { apiAudience, createAuth } from "../src/auth.ts";
import { authenticate, requireClient } from "../src/middleware/auth.ts";
import { testAuthEnv, testDb, testKv } from "./setup.ts";

const secret = randomBytes(32).toString("base64url");
let app!: OpenAPIHono;
const server = serve({ fetch: (req) => app.fetch(req), port: 0, hostname: "127.0.0.1" });
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// A signing key that rotates every second instead of every 30 days.
const auth = createAuth(testDb, {
  ...testAuthEnv(baseURL, secret),
  jwks: { rotationInterval: 1, gracePeriod: 60 },
});
app = createApp({
  db: testDb,
  kv: testKv,
  log: pino({ level: "silent" }),
  auth,
  authenticate: authenticate(auth, baseURL),
});
app.get("/v1/test/alibis", requireClient(["alibis:read"]), (c) => c.json({ ok: true }));

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

async function token(): Promise<string> {
  const c = await auth.api.adminCreateOAuthClient({
    headers: adminHeaders,
    body: {
      client_name: "Rotation agent",
      token_endpoint_auth_method: "client_secret_basic",
      grant_types: ["client_credentials"],
      client_credentials_scopes: ["alibis:read"],
      resources: [apiAudience],
    },
  });
  const res = await fetch(`${baseURL}/api/auth/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${c.client_id}:${c.client_secret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials", resource: apiAudience }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
}

test("the signing key rotates; tokens signed by the old key verify through its grace period", async () => {
  const a = await token();
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const b = await token();
  const [kidA, kidB] = [decodeProtectedHeader(a).kid, decodeProtectedHeader(b).kid];
  expect(kidA).toBeDefined();
  expect(kidB).not.toBe(kidA);
  const jwks = (await (await fetch(`${baseURL}/api/auth/jwks`)).json()) as {
    keys: { kid: string }[];
  };
  expect(jwks.keys.map((k) => k.kid)).toEqual(expect.arrayContaining([kidA, kidB]));
  for (const t of [a, b]) {
    const res = await fetch(`${baseURL}/v1/test/alibis`, {
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.status).toBe(200);
  }
});
