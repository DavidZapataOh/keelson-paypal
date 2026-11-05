import type { MiddlewareHandler } from "hono";
import { pino } from "pino";
import { expect, test } from "vitest";
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

const subject = (): string => `s-${crypto.randomUUID()}`;
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

test("limits anonymous callers by the first forwarded hop only behind a trusted proxy", async () => {
  const proxied = build({ anonymousLimit: 1, trustProxy: true });
  const ip = `203.0.113.${Math.floor(Math.random() * 250)}`;
  const call = (xff: string) =>
    proxied.request("/v1/test/ping", { headers: { "x-forwarded-for": xff } });
  expect((await call(`${ip}, 10.0.0.1`)).status).toBe(200);
  expect((await call(`${ip}, 10.0.0.2`)).status).toBe(429);

  const direct = build({ anonymousLimit: 1 });
  const stale = await testKv.keys("rl:ip:unknown:*");
  if (stale.length > 0) await testKv.del(stale);
  const spoof = (n: number) => ({ headers: { "x-forwarded-for": `198.51.100.${n}` } });
  expect((await direct.request("/v1/test/ping", spoof(1))).status).toBe(200);
  expect((await direct.request("/v1/test/ping", spoof(2))).status).toBe(429);
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
