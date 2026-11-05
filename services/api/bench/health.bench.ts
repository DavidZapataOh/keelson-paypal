import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createDb } from "@keelson/db";
import autocannon from "autocannon";
import { pino } from "pino";
import { createClient, type RedisClientType } from "redis";
import { ulid } from "ulid";
import { createApp } from "../src/app.ts";

const PORT = 10_100;
const REPLAY_PORT = 10_101;
const CONNECTIONS = 50;
const DURATION = 20;
const HEALTH_P95_BUDGET_MS = 15;

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://postgres:keelson@localhost:5432/keelson";
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

interface Summary {
  p50: number;
  p95: number;
  p99: number;
  rps: number;
  non2xx: number;
}

function percentile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}

async function run(options: autocannon.Options): Promise<Summary> {
  const times: number[] = [];
  const result = await new Promise<autocannon.Result>((resolve, reject) => {
    const instance = autocannon(
      { connections: CONNECTIONS, duration: DURATION, ...options },
      (err, res) => (err ? reject(err) : resolve(res)),
    );
    instance.on("response", (_client, _status, _bytes, ms) => times.push(ms));
  });
  times.sort((x, y) => x - y);
  return {
    p50: round(percentile(times, 0.5)),
    p95: round(percentile(times, 0.95)),
    p99: round(percentile(times, 0.99)),
    rps: Math.round(result.requests.average),
    non2xx: result.non2xx,
  };
}

function row(name: string, r: Summary): string {
  return `${name.padEnd(14)} p50 ${r.p50} ms  p95 ${r.p95} ms  p99 ${r.p99} ms  ${r.rps} req/s  non2xx ${r.non2xx}`;
}

async function waitForServer(child: ChildProcess): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error("server exited during startup");
    try {
      if ((await fetch(`http://localhost:${PORT}/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not become ready");
}

const server = spawn(
  process.execPath,
  [fileURLToPath(new URL("../dist/server.js", import.meta.url))],
  {
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(PORT),
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      BETTER_AUTH_URL: "https://localhost",
    },
    stdio: ["ignore", "ignore", "inherit"],
  },
);

const { db, pool } = createDb(databaseUrl);
const kv = createClient({ url: redisUrl }) as RedisClientType;
await kv.connect();
const app = createApp({
  db,
  kv,
  log: pino({ level: "silent" }),
  authenticate: async (c, next) => {
    c.set("principal", { kind: "client", subject: "bench" });
    await next();
  },
  rateLimit: { limit: 1_000_000_000 },
});
app.post("/v1/bench/echo", (c) => c.json({ ok: true }));
const replayServer = serve({ fetch: app.fetch, port: REPLAY_PORT });

let failed = false;
try {
  await waitForServer(server);
  const health = await run({ url: `http://localhost:${PORT}/health` });
  const status = await run({ url: `http://localhost:${PORT}/status` });

  const post = {
    method: "POST",
    url: `http://localhost:${REPLAY_PORT}/v1/bench/echo`,
    body: "{}",
  } as const;
  const headers = { "content-type": "application/json" };
  const first = await run({
    ...post,
    headers,
    requests: [
      {
        setupRequest: (req: autocannon.Request) => ({
          ...req,
          headers: { ...headers, "idempotency-key": ulid() },
        }),
      },
    ],
  });
  const key = ulid();
  await fetch(post.url, {
    method: "POST",
    body: "{}",
    headers: { ...headers, "idempotency-key": key },
  });
  const replay = await run({ ...post, headers: { ...headers, "idempotency-key": key } });

  console.log(row("/health", health));
  console.log(row("/status", status));
  console.log(row("POST first", first));
  console.log(row("POST replay", replay));
  console.log(`replay p95 minus first p95: ${round(replay.p95 - first.p95)} ms`);
  failed = health.p95 >= HEALTH_P95_BUDGET_MS;
} finally {
  server.kill("SIGTERM");
  replayServer.close();
  await Promise.all([pool.end(), kv.close()]);
}
if (failed) {
  console.error(`/health p95 exceeded ${HEALTH_P95_BUDGET_MS} ms`);
  process.exit(1);
}
