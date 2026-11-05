import type { MiddlewareHandler } from "hono";
import { pino } from "pino";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { createKv } from "../src/kv.ts";
import { testDb, testKv } from "./setup.ts";

const log = pino({ level: "silent" });
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

const asPrincipal: MiddlewareHandler = async (c, next) => {
  const subject = c.req.header("x-test-subject");
  if (subject) c.set("principal", { kind: "client", subject });
  await next();
};

function build(options: Parameters<typeof createApp>[0]["rateLimit"] = {}, kv = testKv) {
  const app = createApp({ db: testDb, kv, log, authenticate: asPrincipal, rateLimit: options });
  app.get("/v1/test/ping", (c) => c.json({ ok: true }));
  app.post("/v1/test/write", (c) => c.json({ ok: true }));
  return app;
}

// Freeze the clock mid-window so no test straddles a fixed-window boundary.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Math.floor(Date.now() / 60_000) * 60_000 + 30_000);
});
afterAll(() => {
  vi.useRealTimers();
});

const subject = (): string => `s-${crypto.randomUUID()}`;
const ip = (): string => crypto.getRandomValues(new Uint8Array(4)).join(".");
const remaining = (res: Response): number =>
  Number(/;r=(\d+);/.exec(res.headers.get("ratelimit") ?? "")?.[1]);
const get = (app: ReturnType<typeof build>, who: string, headers: Record<string, string> = {}) =>
  app.request("/v1/test/ping", { headers: { "x-test-subject": who, ...headers } });

test("rejects the request over the limit with Retry-After and RateLimit fields", async () => {
  const app = build({ limit: 3, windowSec: 60 });
  const who = subject();
  const first = await get(app, who);
  expect(first.status).toBe(200);
  expect(first.headers.get("ratelimit-policy")).toBe('"default";q=3;w=60');
  expect(first.headers.get("ratelimit")).toMatch(/^"default";r=2;t=\d+$/);
  await get(app, who);
  const third = await get(app, who);
  expect(third.headers.get("ratelimit")).toMatch(/^"default";r=0;t=\d+$/);

  const fourth = await get(app, who);
  expect(fourth.status).toBe(429);
  const retryAfter = Number(fourth.headers.get("retry-after"));
  expect(retryAfter).toBeGreaterThan(0);
  expect(retryAfter).toBeLessThanOrEqual(60);
  expect(fourth.headers.get("ratelimit")).toBe(`"default";r=0;t=${retryAfter}`);
  expect(fourth.headers.get("content-type")).toContain("application/problem+json");
  expect((await fourth.json()).type).toBe("https://api.keelson.finance/problems/rate-limited");
});

test("counts each principal separately", async () => {
  const app = build({ limit: 1 });
  expect((await get(app, subject())).status).toBe(200);
  expect((await get(app, subject())).status).toBe(200);
});

test("keys anonymous callers by Cloudflare's client IP only behind a trusted proxy", async () => {
  const proxied = build({ anonymousLimit: 1, trustProxy: true });
  const call = (headers: Record<string, string>) => proxied.request("/v1/test/ping", { headers });

  const real = ip();
  const viaCf = (forged: string) => ({
    "cf-connecting-ip": real,
    "x-forwarded-for": `${forged}, ${ip()}, ${ip()}`,
    "true-client-ip": forged,
  });
  expect((await call(viaCf(ip()))).status).toBe(200);
  expect((await call(viaCf(ip()))).status).toBe(429);

  const client = ip();
  const viaXff = (forged: string) => ({
    "x-forwarded-for": `${forged}, ${client}, ${ip()}, ${ip()}`,
  });
  expect((await call(viaXff(ip()))).status).toBe(200);
  expect((await call(viaXff(ip()))).status).toBe(429);
});

test("shares one bucket for callers whose IP cannot be trusted", async () => {
  // Other suites also hit the shared `unknown` bucket, so compare remaining quota instead of
  // counting from zero: two separate fresh buckets would report the same value.
  const proxied = build({ anonymousLimit: 1_000_000, trustProxy: true });
  const short = () => ({ headers: { "x-forwarded-for": `${ip()}, ${ip()}` } });
  const first = remaining(await proxied.request("/v1/test/ping", short()));
  expect(remaining(await proxied.request("/v1/test/ping", short()))).toBeLessThan(first);

  const direct = build({ anonymousLimit: 1_000_000 });
  const spoof = () => ({ headers: { "x-forwarded-for": ip(), "cf-connecting-ip": ip() } });
  const before = remaining(await direct.request("/v1/test/ping", spoof()));
  expect(remaining(await direct.request("/v1/test/ping", spoof()))).toBeLessThan(before);
});

test("lets reads through when the store is unreachable and leaves writes to idempotency", async () => {
  const kv = await createKv(redisUrl, log);
  const app = build({ limit: 1 }, kv);
  kv.destroy();
  const who = subject();
  expect((await get(app, who)).status).toBe(200);
  expect((await get(app, who)).status).toBe(200);
  const post = await app.request("/v1/test/write", {
    method: "POST",
    headers: { "idempotency-key": "k-1", "content-type": "application/json" },
    body: "{}",
  });
  expect(post.status).toBe(503);
  expect((await post.json()).type).toBe(
    "https://api.keelson.finance/problems/dependency-unavailable",
  );
  expect((await app.request("/health")).status).toBe(200);
});
