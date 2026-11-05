import { connect, createServer, type Socket } from "node:net";
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

test("gives up on a dependency that accepts commands but never answers", async () => {
  const target = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
  const sockets: Socket[] = [];
  const proxy = createServer((client) => {
    const upstream = connect(Number(target.port || 6379), target.hostname);
    sockets.push(client);
    client.pipe(upstream).pipe(client);
    client.on("error", () => {});
    upstream.on("error", () => {});
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const { port } = proxy.address() as { port: number };
  const kv = await createKv(`redis://127.0.0.1:${port}`, log);
  for (const socket of sockets) socket.pause();
  try {
    const started = Date.now();
    const res = await createApp({ db: testDb, kv, log }).request("/status");
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(700);
    expect(await res.json()).toMatchObject({ status: "degraded", dependencies: { kv: "down" } });
  } finally {
    kv.destroy();
    for (const socket of sockets) socket.destroy();
    proxy.close();
  }
});
