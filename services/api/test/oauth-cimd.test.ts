import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { serve } from "@hono/node-server";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { eq, oauthClient, operators } from "@keelson/db";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { apiAudience, createAuth } from "../src/auth.ts";
import { hostTier } from "../src/hosted-caps.ts";
import { authenticate } from "../src/middleware/auth.ts";
import { verifiedClient } from "../src/oauth/cimd-trust.ts";
import { testAuthEnv, testDb, testKv } from "./setup.ts";

/**
 * Claude's own Client ID Metadata Document, as claude.ai publishes it: the authorization server
 * fetches it over the internet, as it does in production.
 */
const CLAUDE = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

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

const challenge = () => createHash("sha256").update(randomBytes(32)).digest("base64url");

function authorize(clientId: string, redirectUri: string) {
  return app.request(
    `/api/auth/oauth2/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "alibis:read",
      resource: apiAudience,
      state: "s1",
      code_challenge: challenge(),
      code_challenge_method: "S256",
    })}`,
    { headers: userHeaders },
  );
}

describe("Client ID Metadata Documents", () => {
  test("the authorization server says it takes them, and still takes registrations", async () => {
    const as = await (await app.request("/.well-known/oauth-authorization-server/api/auth")).json();
    expect(as.client_id_metadata_document_supported).toBe(true);
    expect(as.registration_endpoint).toBe(`${baseURL}/api/auth/oauth2/register`);
  });

  test("a client named by its metadata URL is fetched, stored and verified by its host", async () => {
    const res = await authorize(CLAUDE, CLAUDE_REDIRECT);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(`${appOrigin}/consent`);
    const [client] = await testDb
      .select()
      .from(oauthClient)
      .where(eq(oauthClient.clientId, CLAUDE));
    expect(client?.name).toBe("Claude");
    expect(client?.scopes).toEqual(
      expect.arrayContaining(["alibis:read", "mandates:request", "offline_access"]),
    );
    expect(await verifiedClient(testDb, CLAUDE)).toEqual({
      kind: "cimd",
      host: "claude.ai",
      clientUri: "https://claude.ai",
    });
    expect(await hostTier(testDb, CLAUDE, null)).toBe("known");
  });

  test("a redirect URI the document does not list is refused", async () => {
    const res = await authorize(CLAUDE, "https://evil.example.com/callback");
    expect(res.headers.get("location") ?? "").not.toContain("evil.example.com");
    expect(res.headers.get("location") ?? "").toContain("error=invalid_redirect");
  });

  test("a metadata URL on Keelson's own hosts is never fetched", async () => {
    const res = await authorize(
      "https://keelson.finance/.well-known/client.json",
      "https://keelson.finance/cb",
    );
    expect(res.headers.get("location") ?? "").not.toContain("/consent");
    expect(
      await testDb
        .select()
        .from(oauthClient)
        .where(eq(oauthClient.clientId, "https://keelson.finance/.well-known/client.json")),
    ).toHaveLength(0);
  });

  test("a registered client named like a known host stays unverified, in the lower tier", async () => {
    const res = await app.request("/api/auth/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude",
        redirect_uris: [CLAUDE_REDIRECT],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(res.status).toBe(201);
    const { client_id } = (await res.json()) as { client_id: string };
    expect(await verifiedClient(testDb, client_id)).toEqual({ kind: "unverified" });
    expect(await hostTier(testDb, client_id, null)).toBe("unknown");
  });

  test("a client linked to a registered agent is that operator's", async () => {
    const res = await app.request("/api/auth/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Errand",
        redirect_uris: ["https://errand.example.com/cb"],
        token_endpoint_auth_method: "none",
      }),
    });
    const { client_id } = (await res.json()) as { client_id: string };
    const agentId = BigInt(`0x${randomBytes(10).toString("hex")}`);
    await testDb.insert(operators).values({
      agentId,
      chainId: 421614,
      agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
      name: "Errand Labs",
      cnfJwk: {},
      clientId: client_id,
    });
    expect(await verifiedClient(testDb, client_id)).toEqual({
      kind: "operator",
      agentId: agentId.toString(),
      operator: "Errand Labs",
      registry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
    });
  });
});
