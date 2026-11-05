import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { MiddlewareHandler } from "hono";
import { pino } from "pino";
import { expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { eventsChannel } from "../src/events.ts";
import { principalChannel } from "../src/principal.ts";
import { closeServer } from "../src/shutdown.ts";
import { testDb, testKv } from "./setup.ts";

const asPrincipal: MiddlewareHandler = async (c, next) => {
  c.set("principal", { kind: "user", subject: "shutdown" });
  await next();
};

test("closes open event streams and the server promptly", async () => {
  const shutdown = new AbortController();
  const app = createApp({
    db: testDb,
    kv: testKv,
    log: pino({ level: "silent" }),
    authenticate: asPrincipal,
    shutdown: shutdown.signal,
  });
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;

  const channel = principalChannel({ kind: "user", subject: "shutdown" }, "s");
  const res = await fetch(`http://127.0.0.1:${port}/v1/events?channel=${channel}`);
  expect(res.status).toBe(200);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain(": connected");

  const started = Date.now();
  await closeServer(server, shutdown);
  expect(Date.now() - started).toBeLessThan(1000);
  expect((await reader.read()).done).toBe(true);
  const topic = eventsChannel(channel);
  expect(Number((await testKv.pubSubNumSub(topic))[topic])).toBe(0);
});
