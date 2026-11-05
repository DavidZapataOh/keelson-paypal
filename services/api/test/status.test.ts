import { pino } from "pino";
import { expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { createKv } from "../src/kv.ts";
import { testDb, testKv } from "./setup.ts";

const log = pino({ level: "silent" });

test("reports ok when both dependencies are up", async () => {
  const res = await createApp({ db: testDb, kv: testKv, log }).request("/status");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    status: "ok",
    dependencies: { db: "up", kv: "up" },
    version: "0.0.0",
  });
});

test("reports degraded within 600 ms when the key-value store is down", async () => {
  const kv = await createKv(process.env.REDIS_URL ?? "redis://localhost:6379", log);
  kv.destroy();
  const started = Date.now();
  const res = await createApp({ db: testDb, kv, log }).request("/status");
  expect(Date.now() - started).toBeLessThan(600);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    status: "degraded",
    dependencies: { db: "up", kv: "down" },
  });
});
