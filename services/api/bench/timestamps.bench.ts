import { randomBytes } from "node:crypto";
import { createDb, inArray, migrate, timestamps } from "@keelson/db";
import pg from "pg";
import { pino } from "pino";
import { createKv } from "../src/kv.ts";
import { enqueueStamp } from "../src/timestamps/queue.ts";
import { startStampWorker } from "../src/timestamps/worker.ts";

// Enqueues SAMPLES random hashes, one every 250 ms, and reports how long each TSA takes and how
// long a hash waits, from `created_at` to its later `stamped_at`, until both primaries are stamped.
// On Render it uses DATABASE_URL as is; otherwise it creates a throwaway database.
const SAMPLES = Number(process.env.SAMPLES ?? 200);
const INTERVAL_MS = 250;
const BUDGET_P95_MS = 600;
const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:keelson@localhost:5432/keelson";

const percentile = (xs: number[], q: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
};
const summary = (xs: number[]) =>
  `p50 ${percentile(xs, 0.5).toFixed(0)} ms, p95 ${percentile(xs, 0.95).toFixed(0)} ms (n=${xs.length})`;

let url = baseUrl;
let created: string | undefined;
if (!process.env.RENDER) {
  created = `keelson_ts_bench_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${created}`);
  await admin.end();
  const u = new URL(baseUrl);
  u.pathname = `/${created}`;
  url = u.toString();
  await migrate(url);
}
const { db, pool } = createDb(url);
const log = pino({ level: "warn" });
const kv = await createKv(process.env.REDIS_URL ?? "redis://localhost:6379", log);
const stamps = startStampWorker({ db, kv, log });

try {
  const hashes = Array.from({ length: SAMPLES }, () => randomBytes(32));
  for (const hash of hashes) {
    enqueueStamp({ db, log, stamps }, hash, "leaf");
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  const deadline = Date.now() + 120_000;
  let rows: (typeof timestamps.$inferSelect)[] = [];
  while (Date.now() < deadline) {
    rows = await db.select().from(timestamps).where(inArray(timestamps.hash, hashes));
    if (rows.every((r) => r.status !== "pending")) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  for (const tsa of ["digicert", "sigstore"]) {
    const latency = rows
      .filter((r) => r.tsa === tsa && r.status === "stamped")
      .map((r) => r.latencyMs as number);
    console.log(`${tsa} request: ${summary(latency)}`);
  }
  const both: number[] = [];
  for (const hash of hashes) {
    const pair = rows.filter((r) => r.hash.equals(hash) && r.role === "primary");
    if (pair.length !== 2 || pair.some((r) => r.status !== "stamped")) continue;
    const created = Math.min(...pair.map((r) => r.createdAt.getTime()));
    const stamped = Math.max(...pair.map((r) => (r.stampedAt as Date).getTime()));
    both.push(stamped - created);
  }
  console.log(`both primaries stamped: ${summary(both)}, budget p95 ${BUDGET_P95_MS} ms`);
  const unstamped = rows.filter((r) => r.status !== "stamped");
  console.log(`not stamped: ${unstamped.length} rows`);
} finally {
  await stamps.stop();
  await pool.end();
  await kv.close();
  if (created) {
    const admin = new pg.Client({ connectionString: baseUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE ${created} WITH (FORCE)`);
    await admin.end();
  }
}
