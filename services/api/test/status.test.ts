import { connect, createServer, type Socket } from "node:net";
import { paypalEvents } from "@keelson/db";
import { pino } from "pino";
import { ulid } from "ulid";
import { createPublicClient, http, type PublicClient } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { createKv } from "../src/kv.ts";
import { createPayPalDeps } from "../src/paypal.ts";
import { testDb, testKv } from "./setup.ts";

const log = pino({ level: "silent" });

test("reports ok when both dependencies are up", async () => {
  const res = await createApp({ db: testDb, kv: testKv, log }).request("/status");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    status: "ok",
    dependencies: { db: "up", kv: "up" },
    rpc: { calls: [] },
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

    // The PayPal event ages read the same store: they give up too.
    const paypal = createPayPalDeps({
      PAYPAL_CLIENT_ID: "not-a-client",
      PAYPAL_CLIENT_SECRET: "not-a-secret",
      PAYPAL_ENV: "sandbox",
      PAYPAL_MERCHANT_ID: "A4WCRYD5EYDF2",
    });
    const again = Date.now();
    const withPayPal = await createApp({ db: testDb, kv, log, paypal }).request("/status");
    expect(Date.now() - again).toBeLessThan(2_500);
    expect(await withPayPal.json()).toMatchObject({
      dependencies: { webhooks: { status: "down" } },
    });
  } finally {
    kv.destroy();
    for (const socket of sockets) socket.destroy();
    proxy.close();
  }
});

test("reports PayPal down with bad credentials, and the age of the last webhook and poll", async () => {
  const paypal = createPayPalDeps({
    PAYPAL_CLIENT_ID: "not-a-client",
    PAYPAL_CLIENT_SECRET: "not-a-secret",
    PAYPAL_ENV: "sandbox",
    PAYPAL_MERCHANT_ID: "A4WCRYD5EYDF2",
  });
  await testDb.insert(paypalEvents).values({
    id: `WH-STATUS-${ulid()}`,
    eventType: "PAYMENT.CAPTURE.COMPLETED",
    resourceType: "capture",
    resourceId: "status-test",
    source: "webhook",
    transmissionId: ulid(),
    body: Buffer.from("{}"),
  });
  const kv = await createKv(process.env.REDIS_URL ?? "redis://localhost:6379", log);
  await kv.set("paypal:poll:events", new Date(Date.now() - 30_000).toISOString());
  try {
    const res = await createApp({ db: testDb, kv, log, paypal }).request("/status");
    const body = (await res.json()) as {
      status: string;
      dependencies: {
        paypal: unknown;
        webhooks: { status: string; lastWebhookAgeMs: number; lastPollAgeMs: number };
      };
    };
    expect(body.status).toBe("degraded");
    expect(body.dependencies.paypal).toEqual({ status: "down", environment: "sandbox" });
    expect(body.dependencies.webhooks.status).toBe("up");
    expect(body.dependencies.webhooks.lastWebhookAgeMs).toBeLessThan(5_000);
    expect(body.dependencies.webhooks.lastPollAgeMs).toBeGreaterThanOrEqual(30_000);
  } finally {
    kv.destroy();
  }
});

test("reports the anchor down when the chain does not answer", async () => {
  const client = createPublicClient({
    chain: arbitrumSepolia,
    transport: http("http://127.0.0.1:9", { retryCount: 0 }),
  }) as PublicClient;
  const res = await createApp({
    db: testDb,
    kv: testKv,
    log,
    chains: { 421614: { client, logs: client } },
  }).request("/status");
  expect(await res.json()).toMatchObject({
    status: "degraded",
    dependencies: { anchor: { status: "down", environment: "arbitrum-sepolia" } },
  });
});
