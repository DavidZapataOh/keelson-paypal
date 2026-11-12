import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { serve } from "@hono/node-server";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { sql, user as users } from "@keelson/db";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { decodeJwt, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { apiAudience, createAuth } from "../src/auth.ts";
import { authenticate, requireClient } from "../src/middleware/auth.ts";
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
  authBaseUrl: baseURL,
  authenticate: authenticate(auth, baseURL),
});
app.get("/v1/test/alibis", requireClient(["alibis:read"]), (c) => c.json(c.var.principal));

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

/** An agent's own DPoP key (RFC 9449 §4): every proof it sends is signed with it. */
async function dpopKey() {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = (await exportJWK(publicKey)) as JWK;
  return {
    proof: (htm: string, htu: string, accessToken?: string, jti = randomUUID()) =>
      new SignJWT({
        htm,
        htu,
        jti,
        ...(accessToken
          ? { ath: createHash("sha256").update(accessToken).digest("base64url") }
          : {}),
      })
        .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk })
        .setIssuedAt()
        .sign(privateKey),
  };
}

async function client(scopes: string[]) {
  const created = await auth.api.adminCreateOAuthClient({
    headers: adminHeaders,
    body: {
      client_name: "DPoP agent",
      token_endpoint_auth_method: "client_secret_basic",
      grant_types: ["client_credentials"],
      client_credentials_scopes: scopes,
      resources: [apiAudience],
    },
  });
  return { id: created.client_id, secret: created.client_secret as string };
}

async function dpopToken(key: Awaited<ReturnType<typeof dpopKey>>) {
  const c = await client(["alibis:read"]);
  const tokenUrl = `${baseURL}/api/auth/oauth2/token`;
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${c.id}:${c.secret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
      dpop: await key.proof("POST", tokenUrl),
    },
    body: new URLSearchParams({ grant_type: "client_credentials", resource: apiAudience }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { access_token: string; token_type: string };
}

const alibis = `${baseURL}/v1/test/alibis`;

describe("DPoP-bound access tokens (RFC 9449)", () => {
  test("the authorization server advertises DPoP, and binds a token to the proof's key", async () => {
    const as = await (
      await fetch(`${baseURL}/.well-known/oauth-authorization-server/api/auth`)
    ).json();
    expect(as.dpop_signing_alg_values_supported).toEqual(expect.arrayContaining(["ES256"]));
    const prm = await (await fetch(`${baseURL}/.well-known/oauth-protected-resource`)).json();
    expect(prm.dpop_signing_alg_values_supported).toEqual(expect.arrayContaining(["ES256"]));
    const key = await dpopKey();
    const token = await dpopToken(key);
    expect(token.token_type).toBe("DPoP");
    expect((decodeJwt(token.access_token).cnf as { jkt?: string }).jkt).toMatch(/^[\w-]{43}$/);
  });

  test("the API takes the token with a fresh proof for its own method and URL only", async () => {
    const key = await dpopKey();
    const { access_token: t } = await dpopToken(key);
    const ok = await fetch(alibis, {
      headers: { authorization: `DPoP ${t}`, dpop: await key.proof("GET", alibis, t) },
    });
    expect(ok.status).toBe(200);

    const bearer = await fetch(alibis, { headers: { authorization: `Bearer ${t}` } });
    expect(bearer.status).toBe(401);

    const elsewhere = await fetch(alibis, {
      headers: {
        authorization: `DPoP ${t}`,
        dpop: await key.proof("GET", `${baseURL}/v1/mandates`, t),
      },
    });
    expect(elsewhere.status).toBe(401);

    const jti = randomUUID();
    const first = await fetch(alibis, {
      headers: { authorization: `DPoP ${t}`, dpop: await key.proof("GET", alibis, t, jti) },
    });
    expect(first.status).toBe(200);
    const replayed = await fetch(alibis, {
      headers: { authorization: `DPoP ${t}`, dpop: await key.proof("GET", alibis, t, jti) },
    });
    expect(replayed.status).toBe(401);

    const stolen = await dpopKey();
    const otherKey = await fetch(alibis, {
      headers: { authorization: `DPoP ${t}`, dpop: await stolen.proof("GET", alibis, t) },
    });
    expect(otherKey.status).toBe(401);
    expect(otherKey.headers.get("www-authenticate")).toContain("DPoP");
  });

  test("MCP, whose authorization is Bearer only, refuses a DPoP-bound token rather than take it without its proof", async () => {
    const key = await dpopKey();
    const { access_token: t } = await dpopToken(key);
    const mcp = `${baseURL}/mcp`;
    const init = (headers: Record<string, string>) =>
      fetch(mcp, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "dpop-agent", version: "1.0.0" },
          },
        }),
      });
    const bearer = await init({ authorization: `Bearer ${t}` });
    expect(bearer.status).toBe(401);
    expect(bearer.headers.get("www-authenticate")).toContain('error="invalid_token"');
    const dpop = await init({ authorization: `DPoP ${t}`, dpop: await key.proof("POST", mcp, t) });
    expect(dpop.status).toBe(401);
  });
});
