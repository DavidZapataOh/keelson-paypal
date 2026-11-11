import { randomBytes } from "node:crypto";
import { agentConnections, eq, oauthClient, operators } from "@keelson/db";
import { pino } from "pino";
import { ulid } from "ulid";
import { describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { embedPolicy } from "../src/routes/embed-page.ts";
import { testDb, testKv } from "./setup.ts";
import { headerPrincipal } from "./tee-live.ts";

const appOrigin = "https://app.keelson.finance";
const PAGE = "<!doctype html><title>Approve</title>";
const app = createApp({
  db: testDb,
  kv: testKv,
  log: pino({ level: "silent" }),
  authenticate: headerPrincipal,
  appOrigin,
  embedPage: async () => PAGE,
});

const HOST = "https://agents.example.com";
const REGISTRY = "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e";
const REASON =
  "I am Claude Code, buying the running shoes you asked for in this session. I compare prices at RunFast and check out only what you named.";

const asClient = (subject: string) => ({
  "x-test-principal": JSON.stringify({ kind: "client", subject, scopes: ["countersign:write"] }),
});

async function platform(): Promise<string> {
  const clientId = `platform-${ulid()}`;
  await testDb.insert(oauthClient).values({ id: ulid(), clientId, redirectUris: [] });
  await testDb.insert(operators).values({
    agentId: BigInt(`0x${randomBytes(10).toString("hex")}`),
    chainId: 421614,
    agentRegistry: REGISTRY,
    name: "Errand Labs",
    cnfJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    clientId,
  });
  return clientId;
}

const send = (path: string, headers: Record<string, string>, body?: unknown, method = "POST") =>
  app.request(path, {
    method,
    headers: {
      "idempotency-key": ulid(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function ask(clientId: string): Promise<{ deviceCode: string; userCode: string }> {
  const res = await send("/v1/connections", asClient(clientId), {
    name: "Claude Code",
    reason: REASON,
    limits: {
      perPurchaseMinor: 5_000,
      totalMinor: 10_000,
      merchants: ["mrc_runfast"],
      until: new Date(Date.now() + 86_400_000).toISOString(),
    },
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { device_code: string; user_code: string };
  return { deviceCode: body.device_code, userCode: body.user_code };
}

const allow = (clientId: string, origins: string[]) =>
  send("/v1/embed/origins", asClient(clientId), { origins }, "PUT");

async function embedded(clientId: string, origin = HOST) {
  const request = await ask(clientId);
  const res = await send("/v1/connections/embed", asClient(clientId), {
    device_code: request.deviceCode,
    origin,
  });
  const body = (await res.json()) as { url: string; ref: string; expires_in: number };
  return { res, body, request };
}

const tokenOf = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get("t") ?? "";

const open = (token: string) =>
  app.request("/v1/embed/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });

describe("embed origins", () => {
  test("only bare https origins may be registered", async () => {
    const clientId = await platform();
    for (const bad of [
      "http://agents.example.com",
      "https://agents.example.com/",
      "https://agents.example.com/app",
      "https://user@agents.example.com",
      "*",
      "null",
    ]) {
      expect((await allow(clientId, [bad])).status, bad).toBe(422);
    }
    const ok = await allow(clientId, [HOST, "https://agents.example.com:8443"]);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ origins: [HOST, "https://agents.example.com:8443"] });
    expect((await allow(clientId, [HOST])).status).toBe(200);
    expect((await embedded(clientId, "https://agents.example.com:8443")).res.status).toBe(403);
  });

  test("setting origins takes a client token", async () => {
    expect((await send("/v1/embed/origins", {}, { origins: [HOST] }, "PUT")).status).toBe(401);
  });
});

describe("minting an embed", () => {
  test("is refused for an origin the client did not register", async () => {
    const clientId = await platform();
    await allow(clientId, [HOST]);
    const { res, body } = await embedded(clientId, "https://evil.example.net");
    expect(res.status).toBe(403);
    expect((body as unknown as { type: string }).type).toMatch(/\/origin-not-allowed$/);
  });

  test("is refused for another client's request", async () => {
    const owner = await platform();
    const other = await platform();
    await allow(other, [HOST]);
    const request = await ask(owner);
    const res = await send("/v1/connections/embed", asClient(other), {
      device_code: request.deviceCode,
      origin: HOST,
    });
    expect(res.status).toBe(404);
  });

  test("gives a URL whose token rides in the fragment", async () => {
    const clientId = await platform();
    await allow(clientId, [HOST]);
    const { res, body } = await embedded(clientId);
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const url = new URL(body.url);
    expect(url.pathname).toBe("/embed/approve");
    expect(url.protocol).toBe("https:");
    expect(url.searchParams.get("r")).toBe(body.ref);
    expect(tokenOf(body.url)).toMatch(/^ket_[\w-]{43}$/);
    expect(url.search).not.toContain("ket_");
    expect(body.expires_in).toBe(300);
  });
});

describe("the embed page's headers", () => {
  test("only the request's platform may frame it, and it may use no passkey or payment", async () => {
    const clientId = await platform();
    await allow(clientId, [HOST, "https://other.example.com"]);
    const { body } = await embedded(clientId);
    const res = await app.request(`/embed/approve?r=${body.ref}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(PAGE);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toBe(embedPolicy(appOrigin, HOST));
    expect(csp).toContain(`frame-ancestors ${HOST}`);
    expect(csp).not.toContain("other.example.com");
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("permissions-policy")).toContain("publickey-credentials-get=()");
    expect(res.headers.get("permissions-policy")).toContain("payment=()");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("an unknown or malformed ref may be framed by no one", async () => {
    for (const r of [ulid(), "../../etc", "", "01ARZ3NDEKTSV4RRFFQ69G5FA%27"]) {
      const res = await app.request(`/embed/approve?r=${r}`);
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    }
  });

  test("every other route refuses framing", async () => {
    for (const path of ["/health", "/openapi.json", "/v1/connections/BCDF-GHJK", "/nope"]) {
      const res = await app.request(path);
      expect(res.headers.get("content-security-policy"), path).toBe("frame-ancestors 'none'");
      expect(res.headers.get("x-frame-options"), path).toBe("DENY");
    }
  });
});

describe("an embed session", () => {
  test("the token opens one session, once", async () => {
    const clientId = await platform();
    await allow(clientId, [HOST]);
    const { body, request } = await embedded(clientId);
    const first = await open(tokenOf(body.url));
    expect(first.status).toBe(201);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.get("set-cookie")).toBeNull();
    const opened = (await first.json()) as {
      session: string;
      embed: {
        ref: string;
        origin: string;
        request: { code: string; agent: { operator: string } };
      };
    };
    expect(opened.session).toMatch(/^kes_[\w-]{43}$/);
    expect(opened.embed).toMatchObject({ ref: body.ref, origin: HOST });
    expect(opened.embed.request.code).toBe(request.userCode);
    expect(opened.embed.request.agent.operator).toBe("Errand Labs");
    // A replay, even at once, finds nothing.
    expect((await open(tokenOf(body.url))).status).toBe(401);
  });

  test("an expired or forged token opens nothing", async () => {
    const clientId = await platform();
    await allow(clientId, [HOST]);
    const { body } = await embedded(clientId);
    const token = tokenOf(body.url);
    const keys = await testKv.keys("embed:tok:*");
    for (const k of keys) await testKv.del(k);
    expect((await open(token)).status).toBe(401);
    expect((await open(`ket_${randomBytes(32).toString("base64url")}`)).status).toBe(401);
    expect((await open("not-a-token")).status).toBe(401);
  });

  test("reads and declines the request, once, with the session header only", async () => {
    const clientId = await platform();
    await allow(clientId, [HOST]);
    const { body, request } = await embedded(clientId);
    const { session } = (await (await open(tokenOf(body.url))).json()) as { session: string };
    expect((await app.request("/v1/embed/request")).status).toBe(401);
    expect(
      (await app.request("/v1/embed/request", { headers: { "keelson-embed": "kes_forged" } }))
        .status,
    ).toBe(401);
    const read = await app.request("/v1/embed/request", { headers: { "keelson-embed": session } });
    expect(read.status).toBe(200);
    expect(((await read.json()) as { request: { state: string } }).request.state).toBe("PENDING");

    const denied = await send("/v1/embed/deny", { "keelson-embed": session });
    expect(denied.status).toBe(200);
    expect(((await denied.json()) as { request: { state: string } }).request.state).toBe("DENIED");
    expect((await send("/v1/embed/deny", { "keelson-embed": session })).status).toBe(409);

    const [row] = await testDb
      .select()
      .from(agentConnections)
      .where(eq(agentConnections.userCode, request.userCode));
    expect(row?.state).toBe("DENIED");
    expect(row?.userId).toBeNull();
    const poll = await app.request("/v1/connections/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...asClient(clientId) },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: request.deviceCode,
      }),
    });
    expect(((await poll.json()) as { error: string }).error).toBe("access_denied");
  });

  test("an embed for a closed request cannot be minted", async () => {
    const clientId = await platform();
    await allow(clientId, [HOST]);
    const request = await ask(clientId);
    await testDb
      .update(agentConnections)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(agentConnections.userCode, request.userCode));
    const res = await send("/v1/connections/embed", asClient(clientId), {
      device_code: request.deviceCode,
      origin: HOST,
    });
    expect(res.status).toBe(404);
  });
});
