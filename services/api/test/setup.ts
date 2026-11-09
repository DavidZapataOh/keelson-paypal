import { randomBytes } from "node:crypto";
import { createDb, type Db, migrate } from "@keelson/db";
import pg from "pg";
import { pino } from "pino";
import type { RedisClientType } from "redis";
import { afterAll } from "vitest";
import type { AuthEnv } from "../src/auth.ts";
import { createKv } from "../src/kv.ts";

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL is not set");

function urlFor(database: string): string {
  const url = new URL(baseUrl as string);
  url.pathname = `/${database}`;
  return url.toString();
}

async function admin(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: baseUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/**
 * Drops a test database once the server holds no connection to it. `pool.end()` resolves before the server has
 * closed the pool's connections, and a forced drop would terminate those still closing, which then report `57P01`.
 */
async function dropDatabase(name: string): Promise<void> {
  const client = new pg.Client({ connectionString: baseUrl });
  await client.connect();
  try {
    for (let i = 0; i < 200; i++) {
      const { rows } = await client.query<{ n: number }>(
        "select count(*)::int as n from pg_stat_activity where datname = $1",
        [name],
      );
      if (rows[0]?.n === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await client.query(`DROP DATABASE ${name} WITH (FORCE)`);
  } finally {
    await client.end();
  }
}

/** Whether a process with this id is running. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Drops the databases of earlier runs whose process is gone: runs killed before their `afterAll`. */
async function dropOrphans(prefix: string): Promise<void> {
  const client = new pg.Client({ connectionString: baseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ datname: string }>(
      "select datname from pg_database where starts_with(datname, $1)",
      [prefix],
    );
    for (const { datname } of rows) {
      if (alive(Number(datname.slice(prefix.length).split("_")[0]))) continue;
      await client.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
    }
  } finally {
    await client.end();
  }
}

await dropOrphans("keelson_api_test_");
const name = `keelson_api_test_${process.pid}_${randomBytes(4).toString("hex")}`;
await admin(`CREATE DATABASE ${name}`);
const url = urlFor(name);
const handle = createDb(url);
export const testKv: RedisClientType = await createKv(
  process.env.REDIS_URL ?? "redis://localhost:6379",
  pino({ level: "silent" }),
);

afterAll(async () => {
  await handle.pool.end();
  await testKv.close();
  await dropDatabase(name);
});

await migrate(url);

export const testDb: Db = handle.db;
/** The connection string of this run's database. */
export const testDbUrl: string = url;

/** Auth settings for a server at `baseURL` that also serves the app. */
export function testAuthEnv(baseURL: string, secret: string): AuthEnv {
  return {
    BETTER_AUTH_SECRET: secret,
    BETTER_AUTH_URL: baseURL,
    APP_ORIGIN: baseURL,
    PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID ?? "",
    PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET ?? "",
    PAYPAL_ENV: "sandbox",
  };
}
