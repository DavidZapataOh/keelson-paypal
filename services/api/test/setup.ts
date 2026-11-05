import { randomBytes } from "node:crypto";
import { createDb, type Db, migrate } from "@keelson/db";
import pg from "pg";
import { pino } from "pino";
import type { RedisClientType } from "redis";
import { afterAll } from "vitest";
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

const name = `keelson_api_test_${process.pid}_${randomBytes(4).toString("hex")}`;
await admin(`CREATE DATABASE ${name}`);
const url = urlFor(name);
await migrate(url);
const handle = createDb(url);

export const testDb: Db = handle.db;
export const testKv: RedisClientType = await createKv(
  process.env.REDIS_URL ?? "redis://localhost:6379",
  pino({ level: "silent" }),
);

afterAll(async () => {
  await handle.pool.end();
  await testKv.close();
  await admin(`DROP DATABASE ${name} WITH (FORCE)`);
});
