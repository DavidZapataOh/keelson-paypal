import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { serve } from "@hono/node-server";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { type Mandate, parseMandate } from "@keelson/mandate";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { pino } from "pino";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import demoJson from "../../../packages/mandate/test/fixtures/demo-mandate.json" with {
  type: "json",
};
import { createApp, type Deps } from "../src/app.ts";
import { createAuth } from "../src/auth.ts";
import { authenticate } from "../src/middleware/auth.ts";
import { testAuthEnv, testDb, testKv } from "./setup.ts";

const live = process.env.KEELSON_LIVE === "1";
if (live) process.loadEnvFile(new URL("../../../.env", import.meta.url));

const demo: Mandate = parseMandate(demoJson);
const secret = randomBytes(32).toString("base64url");
let app!: OpenAPIHono;
const server = serve({ fetch: (req) => app.fetch(req), port: 0, hostname: "127.0.0.1" });
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const auth = createAuth(testDb, testAuthEnv(baseURL, secret));

// The parties of the signed demo mandate, issued to the session user.
const compileContext: NonNullable<Deps["compileContext"]> = async (userId) => ({
  mode: demo.mode,
  user: { ...demo.user, sub: userId },
  agent: demo.agent,
  consent: demo.consent,
  policy: demo.policy,
  risk_data: demo.risk_data,
});

const build = (configured = true) =>
  createApp({
    db: testDb,
    kv: testKv,
    log: pino({ level: "silent" }),
    auth,
    authenticate: authenticate(auth, baseURL),
    ...(configured ? { compileContext } : {}),
  });
app = build();

const helpers = betterAuth({
  database: drizzleAdapter(testDb, { provider: "pg" }),
  secret,
  baseURL,
  plugins: [testUtils()],
});
let signIn!: () => Promise<Headers>;

beforeAll(async () => {
  const { test: utils } = await helpers.$context;
  signIn = async () => {
    const user = await utils.saveUser(utils.createUser());
    return utils.getAuthHeaders({ userId: user.id });
  };
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const problemType = (slug: string) => `https://api.keelson.finance/problems/${slug}`;

function compile(
  prompt: string,
  headers: Headers | undefined,
  key = crypto.randomUUID(),
  on: OpenAPIHono = app,
) {
  const h = new Headers(headers);
  h.set("content-type", "application/json");
  h.set("idempotency-key", key);
  return on.request("/v1/mandates/compile", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ prompt }),
  });
}

test("requires a session", async () => {
  const res = await compile("Running shoes under $100", undefined);
  expect(res.status).toBe(401);
});

test("rejects a prompt over 2,000 characters before compiling it", async () => {
  const headers = await signIn();
  const res = await compile("x".repeat(2001), headers);
  expect(res.status).toBe(422);
  expect(res.headers.get("content-type")).toContain("application/problem+json");
  expect((await res.json()).type).toBe(problemType("prompt-too-long"));
});

test("limits each user to 10 compilations a minute", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Math.floor(Date.now() / 60_000) * 60_000 + 30_000);
  try {
    const headers = await signIn();
    for (let i = 0; i < 10; i++)
      expect((await compile("x".repeat(2001), headers)).status).toBe(422);
    const limited = await compile("x".repeat(2001), headers);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("ratelimit-policy")).toContain('"compile";q=10;w=60');
    expect((await compile("x".repeat(2001), await signIn())).status).toBe(422);
  } finally {
    vi.useRealTimers();
  }
});

test("answers 503 where compiling is not configured", async () => {
  const res = await compile("Running shoes under $100", await signIn(), undefined, build(false));
  expect(res.status).toBe(503);
  expect((await res.json()).type).toBe(problemType("compile-unavailable"));
});

test.runIf(live)(
  "compiles the demo request into a draft with its card",
  { timeout: 120_000 },
  async () => {
    const headers = await signIn();
    const key = crypto.randomUUID();
    const prompt = "Running shoes, size 10, under $100, free returns, by Friday";
    const res = await compile(prompt, headers, key);
    expect(res.status).toBe(200);
    const body = await res.json();
    const draft = parseMandate(body.mandateDraft);
    expect(draft.payment.constraints).toContainEqual({
      type: "payment.amount_range",
      max: 10000,
      currency: "USD",
    });
    expect(body.card.rows.find((r: { field: string }) => r.field === "total").values).toEqual([
      "100.00 USD",
    ]);
    expect(body.ambiguous).toContain("merchant");
    expect(["ok", "failed", "refused"]).toContain(body.check.status);
    console.log("ambiguous:", body.ambiguous, "check:", body.check);

    const replay = await compile(prompt, headers, key);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await replay.json()).toEqual(body);
  },
);
