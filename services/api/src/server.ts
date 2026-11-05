import { serve } from "@hono/node-server";
import { createDb } from "@keelson/db";
import { pino } from "pino";
import { createApp } from "./app.ts";
import { parseEnv } from "./env.ts";

const env = parseEnv();
const log = pino();
const { db, pool } = createDb(env.DATABASE_URL);
const app = createApp({ db, log });

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log.info({ port: info.port }, "listening");
});

process.once("SIGTERM", () => {
  server.close(() => {
    void pool.end().then(() => process.exit(0));
  });
});
