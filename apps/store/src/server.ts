import { serve } from "@hono/node-server";
import { createPayPal, paypalConfig, TokenCache } from "@keelson/paypal";
import { pino } from "pino";
import { createClient, type RedisClientType } from "redis";
import { createApp } from "./app.ts";

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

const log = pino();
const cfg = paypalConfig();
const kv = createClient({
  url: required("REDIS_URL"),
  disableOfflineQueue: true,
  socket: { connectTimeout: 5_000 },
}) as RedisClientType;
kv.on("error", (err) => log.warn({ err }, "valkey client error"));
await kv.connect();

const app = createApp({
  paypal: createPayPal(cfg, new TokenCache(cfg)),
  clientId: cfg.clientId,
  environment: cfg.env,
  kv,
  attackToken: required("STORE_ATTACK_TOKEN"),
  origin: required("STORE_ORIGIN"),
  log,
});

const server = serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) }, (info) =>
  log.info({ port: info.port }, "store listening"),
);

process.once("SIGTERM", () => {
  server.close(() => {
    void kv.close().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 10_000).unref();
});
