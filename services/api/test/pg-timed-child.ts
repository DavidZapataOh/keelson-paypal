// Runs one query inside a purchase step, with `@keelson/db` imported before any module of this
// process starts, as the server's imports load it, and prints the step's recorded timings.
import { createDb, sql } from "@keelson/db";
import { pino } from "pino";
import { ulid } from "ulid";
import { createKv } from "../src/kv.ts";
import { purchaseTimings, timings } from "../src/server-timing.ts";
import { span } from "../src/tracing.ts";

const { db, pool } = createDb(process.env.DATABASE_URL as string);
const kv = await createKv(process.env.REDIS_URL as string, pino({ level: "silent" }));
timings.use(kv);
const id = ulid();
await span("purchase.LOGGED", { "purchase.id": id }, () => db.execute(sql`select pg_sleep(0.05)`));
await timings.forceFlush();
process.stdout.write(JSON.stringify(await purchaseTimings(kv, id)));
await kv.quit();
await pool.end();
