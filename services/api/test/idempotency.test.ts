import { connect, createServer, type Server, type Socket } from "node:net";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { pino } from "pino";
import type { RedisClientType } from "redis";
import { beforeEach, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { createKv } from "../src/kv.ts";
import { testDb, testKv } from "./setup.ts";

const log = pino({ level: "silent" });
let count = 0;
let failNext = false;

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

const asPrincipal: MiddlewareHandler = async (c, next) => {
  const subject = c.req.header("x-test-subject");
  if (subject) c.set("principal", { kind: "client", subject });
  await next();
};

function build(
  kv: RedisClientType = testKv,
  extra: Partial<Parameters<typeof createApp>[0]> = {},
): OpenAPIHono {
  const app = createApp({ db: testDb, kv, log, authenticate: asPrincipal, ...extra });
  app.post("/v1/test/echo", async (c) => {
    count += 1;
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (failNext) {
      failNext = false;
      return c.json({ error: "boom" }, 500);
    }
    return c.json({ n: count });
  });
  return app;
}

const app = build();

function post(key: string | undefined, body: unknown, target = app): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== undefined) headers["idempotency-key"] = key;
  return Promise.resolve(
    target.request("/v1/test/echo", { method: "POST", headers, body: JSON.stringify(body) }),
  );
}

const uniqueKey = (): string => `k-${crypto.randomUUID()}`;

beforeEach(() => {
  count = 0;
  failNext = false;
});

test("replays the stored response byte for byte", async () => {
  const key = uniqueKey();
  const first = await post(key, { a: 1 });
  const second = await post(key, { a: 1 });
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(await second.text()).toBe(await first.text());
  expect(count).toBe(1);
  expect(first.headers.get("idempotent-replayed")).toBeNull();
  expect(second.headers.get("idempotent-replayed")).toBe("true");
  expect(second.headers.get("content-type")).toBe(first.headers.get("content-type"));
});

test("rejects the same key with a different body", async () => {
  const key = uniqueKey();
  await post(key, { a: 1 });
  const res = await post(key, { a: 2 });
  expect(res.status).toBe(422);
  expect(res.headers.get("content-type")).toBe("application/problem+json");
  expect((await res.json()).type).toBe(
    "https://api.keelson.finance/problems/idempotency-key-reused",
  );
  expect(count).toBe(1);
});

test("requires the header", async () => {
  const res = await post(undefined, { a: 1 });
  expect(res.status).toBe(400);
  expect((await res.json()).type).toBe(
    "https://api.keelson.finance/problems/idempotency-key-required",
  );
  expect(count).toBe(0);
});

test("rejects a key longer than 255 characters", async () => {
  const res = await post("x".repeat(256), { a: 1 });
  expect(res.status).toBe(400);
});

test("answers 409 while the first request is running", async () => {
  const key = uniqueKey();
  const [a, b] = await Promise.all([post(key, { a: 1 }), post(key, { a: 1 })]);
  const statuses = [a.status, b.status].sort();
  expect(statuses).toEqual([200, 409]);
  const loser = a.status === 409 ? a : b;
  expect((await loser.json()).type).toBe(
    "https://api.keelson.finance/problems/idempotency-in-progress",
  );
  expect(count).toBe(1);
});

test("releases the key after a 5xx so the retry runs again", async () => {
  const key = uniqueKey();
  failNext = true;
  const first = await post(key, { a: 1 });
  expect(first.status).toBe(500);
  const retry = await post(key, { a: 1 });
  expect(retry.status).toBe(200);
  expect(retry.headers.get("idempotent-replayed")).toBeNull();
  expect(count).toBe(2);
});

test("stores 4xx responses", async () => {
  const key = uniqueKey();
  const app4 = createApp({ db: testDb, kv: testKv, log });
  let runs = 0;
  app4.post("/v1/test/reject", (c) => {
    runs += 1;
    return c.json({ error: "no" }, 409);
  });
  const call = () =>
    app4.request("/v1/test/reject", {
      method: "POST",
      headers: { "idempotency-key": key, "content-type": "application/json" },
      body: "{}",
    });
  expect((await call()).status).toBe(409);
  const replay = await call();
  expect(replay.status).toBe(409);
  expect(replay.headers.get("idempotent-replayed")).toBe("true");
  expect(runs).toBe(1);
});

test("fails closed within a second when the connection drops", async () => {
  const target = new URL(redisUrl);
  const sockets = new Set<Socket>();
  const proxy: Server = createServer((client) => {
    const upstream = connect(Number(target.port || 6379), target.hostname);
    sockets.add(client);
    sockets.add(upstream);
    client.pipe(upstream).pipe(client);
    client.on("error", () => {});
    upstream.on("error", () => {});
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const { port } = proxy.address() as { port: number };
  const kv = await createKv(`redis://127.0.0.1:${port}`, log);
  proxy.close();
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 100));

  const started = Date.now();
  let res: Response;
  try {
    res = await post(uniqueKey(), { a: 1 }, build(kv));
  } finally {
    kv.destroy();
  }
  expect(res.status).toBe(503);
  expect(Date.now() - started).toBeLessThan(1000);
  expect((await res.json()).type).toBe(
    "https://api.keelson.finance/problems/dependency-unavailable",
  );
  expect(count).toBe(0);
});

test("includes the query string in the fingerprint", async () => {
  const key = uniqueKey();
  const call = (query: string) =>
    app.request(`/v1/test/echo${query}`, {
      method: "POST",
      headers: { "idempotency-key": key, "content-type": "application/json" },
      body: "{}",
    });
  expect((await call("?a=1")).status).toBe(200);
  const res = await call("?a=2");
  expect(res.status).toBe(422);
  expect((await res.json()).type).toBe(
    "https://api.keelson.finance/problems/idempotency-key-reused",
  );
  expect(count).toBe(1);
});

test("keeps the lock when the response cannot be saved", async () => {
  const errors: string[] = [];
  const spy = pino({ level: "error" }, { write: (line: string) => errors.push(line) });
  const kv = await createKv(redisUrl, log);
  const app2 = createApp({ db: testDb, kv, log: spy });
  let runs = 0;
  app2.post("/v1/test/close", async (c) => {
    runs += 1;
    await kv.close();
    return c.json({ ok: true });
  });
  const key = uniqueKey();
  const res = await app2.request("/v1/test/close", {
    method: "POST",
    headers: { "idempotency-key": key, "content-type": "application/json" },
    body: "{}",
  });
  expect(res.status).toBe(200);
  expect(runs).toBe(1);
  expect(errors.join("")).toContain("failed to save idempotent response");
  const stored = JSON.parse((await testKv.get(`idem:anon:${key}`)) as string);
  expect(stored.state).toBe("running");
  const ttl = await testKv.ttl(`idem:anon:${key}`);
  expect(ttl).toBeGreaterThan(0);
  expect(ttl).toBeLessThanOrEqual(60);
});

test("does not share keys between principals", async () => {
  const key = uniqueKey();
  const as = (subject: string) =>
    app.request("/v1/test/echo", {
      method: "POST",
      headers: {
        "idempotency-key": key,
        "content-type": "application/json",
        "x-test-subject": subject,
      },
      body: "{}",
    });
  const a = await as("a:1");
  const b = await as("b");
  const a2 = await as("a:1");
  expect(a.status).toBe(200);
  expect(b.status).toBe(200);
  expect(a2.headers.get("idempotent-replayed")).toBe("true");
  expect(b.headers.get("idempotent-replayed")).toBeNull();
  expect(count).toBe(2);
});

test("answers 504 on timeout and keeps the lock until the handler finishes", async () => {
  const slow = build(testKv, { requestTimeoutMs: 50 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let runs = 0;
  let finished!: () => void;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  slow.post("/v1/test/slow", async (c) => {
    runs += 1;
    await gate;
    finished();
    return c.json({ ok: true });
  });
  const key = uniqueKey();
  const call = () =>
    slow.request("/v1/test/slow", {
      method: "POST",
      headers: { "idempotency-key": key, "content-type": "application/json" },
      body: "{}",
    });
  const first = await call();
  expect(first.status).toBe(504);
  expect((await first.json()).type).toBe("https://api.keelson.finance/problems/timeout");
  const retry = await call();
  expect(retry.status).toBe(409);
  expect((await retry.json()).type).toBe(
    "https://api.keelson.finance/problems/idempotency-in-progress",
  );
  expect(runs).toBe(1);
  release();
  await done;
});

test("releases the key when the handler throws", async () => {
  const app3 = build();
  let runs = 0;
  app3.post("/v1/test/throw", () => {
    runs += 1;
    throw new Error("boom");
  });
  const key = uniqueKey();
  const call = () =>
    app3.request("/v1/test/throw", {
      method: "POST",
      headers: { "idempotency-key": key, "content-type": "application/json" },
      body: "{}",
    });
  expect((await call()).status).toBe(500);
  expect((await call()).status).toBe(500);
  expect(runs).toBe(2);
});

test("rejects bodies over 1 MiB", async () => {
  const res = await app.request("/v1/test/echo", {
    method: "POST",
    headers: { "idempotency-key": uniqueKey(), "content-type": "application/json" },
    body: "x".repeat(1024 * 1024 + 1),
  });
  expect(res.status).toBe(413);
  expect((await res.json()).type).toBe("https://api.keelson.finance/problems/payload-too-large");
});
