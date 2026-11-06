import "./telemetry.ts";
import Anthropic from "@anthropic-ai/sdk";
import { serve } from "@hono/node-server";
import { createDb } from "@keelson/db";
import { pino } from "pino";
import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { parseEnv } from "./env.ts";
import { createKv } from "./kv.ts";
import { createLogger } from "./logger.ts";
import { authenticate } from "./middleware/auth.ts";
import { closeServer } from "./shutdown.ts";

const FORCE_EXIT_MS = 10_000;

const env = parseEnv();
const destination = pino.destination({ sync: false });
const log = createLogger(destination);
const { db, pool } = createDb(env.DATABASE_URL);
const kv = await createKv(env.REDIS_URL, log);
const auth = createAuth(db, env);
const shutdown = new AbortController();
const app = createApp({
  db,
  kv,
  log,
  auth,
  appOrigin: env.APP_ORIGIN,
  passkeyRpId: env.PASSKEY_RP_ID,
  authenticate: authenticate(auth, env.BETTER_AUTH_URL),
  rateLimit: { trustProxy: process.env.RENDER === "true" },
  shutdown: shutdown.signal,
  ...(env.ANTHROPIC_API_KEY ? { anthropic: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) } : {}),
});

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log.info({ port: info.port }, "listening");
});

process.once("SIGTERM", () => {
  setTimeout(() => {
    log.error("shutdown timed out");
    destination.flushSync();
    process.exit(1);
  }, FORCE_EXIT_MS).unref();
  void closeServer(server, shutdown)
    .then(() => Promise.all([pool.end(), kv.close()]))
    .then(
      () => 0,
      (err: unknown) => {
        log.error({ err }, "shutdown failed");
        return 1;
      },
    )
    .then((code) => {
      destination.flushSync();
      process.exit(code);
    });
});
