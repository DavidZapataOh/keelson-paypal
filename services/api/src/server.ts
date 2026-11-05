import { serve } from "@hono/node-server";
import { createDb } from "@keelson/db";
import { pino } from "pino";
import { createApp } from "./app.ts";
import { parseEnv } from "./env.ts";
import { createKv } from "./kv.ts";

const env = parseEnv();
const log = pino();
const { db, pool } = createDb(env.DATABASE_URL);
const kv = await createKv(env.REDIS_URL);
const app = createApp({ db, kv, log });

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log.info({ port: info.port }, "listening");
});

process.once("SIGTERM", () => {
  server.close(() => {
    void Promise.all([pool.end(), kv.close()]).then(() => process.exit(0));
  });
});
