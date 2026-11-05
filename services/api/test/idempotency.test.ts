import type { OpenAPIHono } from "@hono/zod-openapi";
import { pino } from "pino";
import { beforeEach, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { createKv } from "../src/kv.ts";
import { testDb, testKv } from "./setup.ts";

const log = pino({ level: "silent" });
let count = 0;
let failNext = false;

function build(kv = testKv): OpenAPIHono {
  const app = createApp({ db: testDb, kv, log });
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

test("fails closed when the store is unreachable", async () => {
  const kv = await createKv(process.env.REDIS_URL ?? "redis://localhost:6379");
  await kv.close();
  const res = await post(uniqueKey(), { a: 1 }, build(kv));
  expect(res.status).toBe(503);
  expect((await res.json()).type).toBe(
    "https://api.keelson.finance/problems/dependency-unavailable",
  );
  expect(count).toBe(0);
});
