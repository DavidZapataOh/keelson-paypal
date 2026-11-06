import { generateKeyPairSync, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import Anthropic from "@anthropic-ai/sdk";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { serve } from "@hono/node-server";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { passkey } from "@keelson/db";
import { type Mandate, parseMandate, prepareSigning } from "@keelson/mandate";
import { POLICY_SET_HASH } from "@keelson/policy/hashes";
import { cose, isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { pino } from "pino";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import demoJson from "../../../packages/mandate/test/fixtures/demo-mandate.json" with {
  type: "json",
};
import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth.ts";
import { authenticate } from "../src/middleware/auth.ts";
import { LOCK_SECONDS } from "../src/middleware/idempotency.ts";
import { COMPILE_DEADLINE_MS, COMPILE_LIMITS, type CompileSources } from "../src/routes/compile.ts";
import { testAuthEnv, testDb, testKv } from "./setup.ts";

const live = process.env.KEELSON_LIVE === "1";
if (live) process.loadEnvFile(new URL("../../../.env", import.meta.url));

const demo: Mandate = parseMandate(demoJson);
const secret = randomBytes(32).toString("base64url");
let app!: OpenAPIHono;
const server = serve({ fetch: (req, env) => app.fetch(req, env), port: 0, hostname: "127.0.0.1" });
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const auth = createAuth(testDb, testAuthEnv(baseURL, secret));

// The inputs owned by the TEE and operator work, taken from the signed demo mandate.
const demoSources: Required<CompileSources> = {
  agent: async () => demo.agent,
  consent: async () => demo.consent,
  engine: async () => ({
    engine: demo.policy.engine,
    version: demo.policy.version,
    measurements: demo.policy.measurements,
  }),
};

const anthropic = live ? new Anthropic() : undefined;

const build = (compileSources?: CompileSources, client: Anthropic | null | undefined = anthropic) =>
  createApp({
    db: testDb,
    kv: testKv,
    log: pino({ level: "silent" }),
    auth,
    authenticate: authenticate(auth, baseURL),
    ...(compileSources ? { compileSources } : {}),
    ...(client ? { anthropic: client } : {}),
  });
app = build(demoSources);

const helpers = betterAuth({
  database: drizzleAdapter(testDb, { provider: "pg" }),
  secret,
  baseURL,
  plugins: [testUtils()],
});

interface User {
  id: string;
  email: string;
  headers: Headers;
}
let signIn!: () => Promise<User>;

beforeAll(async () => {
  const { test: utils } = await helpers.$context;
  signIn = async () => {
    const user = await utils.saveUser(utils.createUser());
    return {
      id: user.id,
      email: user.email,
      headers: await utils.getAuthHeaders({ userId: user.id }),
    };
  };
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** Stores an ES256 passkey for `userId`, as registration would, and returns its credential id. */
async function addPasskey(userId: string, createdAt: Date): Promise<string> {
  const { x, y } = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({
    format: "jwk",
  });
  const key = new Map<number, number | Uint8Array>([
    [cose.COSEKEYS.kty, cose.COSEKTY.EC2],
    [cose.COSEKEYS.alg, cose.COSEALG.ES256],
    [cose.COSEKEYS.crv, cose.COSECRV.P256],
    [cose.COSEKEYS.x, isoBase64URL.toBuffer(x as string)],
    [cose.COSEKEYS.y, isoBase64URL.toBuffer(y as string)],
  ]);
  const credentialID = randomBytes(16).toString("base64url");
  await testDb.insert(passkey).values({
    id: crypto.randomUUID(),
    userId,
    credentialID,
    publicKey: Buffer.from(isoCBOR.encode(key)).toString("base64"),
    counter: 0,
    deviceType: "singleDevice",
    backedUp: false,
    createdAt,
  });
  return credentialID;
}

const problemType = (slug: string) => `https://api.keelson.finance/problems/${slug}`;

function compile(
  body: Record<string, unknown>,
  user: User | undefined,
  { key = crypto.randomUUID(), device = "dev_9f2c" as string | null } = {},
) {
  const h = new Headers(user?.headers);
  h.set("content-type", "application/json");
  h.set("idempotency-key", key);
  if (device !== null) h.set("keelson-device", device);
  return fetch(`${baseURL}/v1/mandates/compile`, {
    method: "POST",
    headers: h,
    body: JSON.stringify(body),
  });
}

const DEMO_PROMPT = "Running shoes, size 10, under $100, free returns, by Friday";

test("requires a session", async () => {
  expect((await compile({ prompt: DEMO_PROMPT }, undefined)).status).toBe(401);
});

test("rejects a prompt over 2,000 characters before compiling it", async () => {
  const res = await compile({ prompt: "x".repeat(2001) }, await signIn());
  expect(res.status).toBe(422);
  expect(res.headers.get("content-type")).toContain("application/problem+json");
  expect((await res.json()).type).toBe(problemType("prompt-too-long"));
});

test("limits each user to 10 compilations a minute", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Math.floor(Date.now() / 60_000) * 60_000 + 30_000);
  try {
    const user = await signIn();
    const long = { prompt: "x".repeat(2001) };
    for (let i = 0; i < 10; i++) expect((await compile(long, user)).status).toBe(422);
    const limited = await compile(long, user);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("ratelimit-policy")).toContain('"compile";q=10;w=60');
    expect((await compile(long, await signIn())).status).toBe(422);
  } finally {
    vi.useRealTimers();
  }
});

test("needs a passkey of the user's own to compile for", async () => {
  const user = await signIn();
  const none = await compile({ prompt: DEMO_PROMPT }, user);
  expect(none.status).toBe(409);
  expect((await none.json()).type).toBe(problemType("passkey-required"));

  const other = await signIn();
  const foreign = await addPasskey(other.id, new Date());
  await addPasskey(user.id, new Date());
  const res = await compile({ prompt: DEMO_PROMPT, credentialId: foreign }, user);
  expect(res.status).toBe(403);
  expect((await res.json()).type).toBe(problemType("credential-not-owned"));
});

test("needs the device the app identifies itself with", async () => {
  const user = await signIn();
  await addPasskey(user.id, new Date());
  const res = await compile({ prompt: DEMO_PROMPT }, user, { device: null });
  expect(res.status).toBe(422);
  expect((await res.json()).type).toBe(problemType("device-required"));
});

test("answers 503 naming the inputs that are not available yet", async () => {
  const user = await signIn();
  await addPasskey(user.id, new Date());
  try {
    app = build(undefined, null);
    const none = await compile({ prompt: DEMO_PROMPT }, user);
    const body = await none.json();
    expect(none.status).toBe(503);
    expect(body.type).toBe(problemType("compile-unavailable"));
    expect(body.missing).toEqual(["agent", "consent", "engine", "anthropic"]);

    app = build({ agent: demoSources.agent }, null);
    const partial = await (await compile({ prompt: DEMO_PROMPT }, user)).json();
    expect(partial.missing).toEqual(["consent", "engine", "anthropic"]);
  } finally {
    app = build(demoSources);
  }
});

test("never records an unknown client address in a mandate", async () => {
  const user = await signIn();
  await addPasskey(user.id, new Date());
  const h = new Headers(user.headers);
  h.set("content-type", "application/json");
  h.set("idempotency-key", crypto.randomUUID());
  h.set("keelson-device", "dev_9f2c");
  // Without the Node server, the request has no socket to read the address from.
  const res = await app.request("/v1/mandates/compile", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ prompt: DEMO_PROMPT }),
  });
  expect(res.status).toBe(422);
  expect((await res.json()).type).toBe(problemType("client-ip-required"));
});

test("ends every model call inside the request deadline and the idempotency lock", () => {
  const worst = (l: { timeout: number; maxRetries: number }) => l.timeout * (l.maxRetries + 1);
  const pair = Math.max(worst(COMPILE_LIMITS.opus), worst(COMPILE_LIMITS.sonnet));
  expect(pair + worst(COMPILE_LIMITS.haiku)).toBeLessThan(COMPILE_DEADLINE_MS);
  expect(COMPILE_DEADLINE_MS).toBeLessThan(30_000);
  expect(30_000).toBeLessThan(LOCK_SECONDS * 1000);
});

test.runIf(live)(
  "compiles the demo request for the user's chosen passkey",
  { timeout: 120_000 },
  async () => {
    const user = await signIn();
    const older = await addPasskey(user.id, new Date(Date.now() - 60_000));
    const newest = await addPasskey(user.id, new Date());
    const key = crypto.randomUUID();
    const res = await compile({ prompt: DEMO_PROMPT, credentialId: older }, user, { key });
    expect(res.status).toBe(200);
    const body = await res.json();
    const draft = parseMandate(body.mandateDraft);
    expect(draft.payment.constraints).toContainEqual({
      type: "payment.amount_range",
      max: 10000,
      currency: "USD",
    });
    expect(draft.user.sub).toBe(user.id);
    expect(draft.user.app_login_id).toBe(user.email);
    expect(draft.user.cred.id).toBe(older);
    expect(draft.user.cred.id).not.toBe(newest);
    expect(draft.policy.policy_set_hash).toBe(POLICY_SET_HASH);
    expect(draft.risk_data.device_fp).toBe("dev_9f2c");
    expect(draft.risk_data.ip).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
    expect(draft.mode).toBe("autonomous");
    expect(body.card.rows.find((r: { field: string }) => r.field === "total").values).toEqual([
      "100.00 USD",
    ]);
    expect(body.ambiguous).toContain("merchant");

    // The card the user signs is the card the compile showed, ambiguous fields gray.
    const signing = await prepareSigning(
      draft,
      crypto.getRandomValues(new Uint8Array(16)),
      { merchantSignedCheckout: false, zkTlsFields: new Set() },
      body.ambiguous,
    );
    expect(signing.card).toEqual(body.card);

    const replay = await compile({ prompt: DEMO_PROMPT, credentialId: older }, user, { key });
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await replay.json()).toEqual(body);
  },
);
