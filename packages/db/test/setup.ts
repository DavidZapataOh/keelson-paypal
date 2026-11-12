import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, inject } from "vitest";
import { createDb, type Db, migrate } from "../src/client.ts";

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL is not set");

function urlFor(database: string): string {
  const url = new URL(baseUrl as string);
  url.pathname = `/${database}`;
  return url.toString();
}

async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: baseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const prefix = inject("databasePrefix");

/** Creates a fresh migrated database and runs `fn` against it; the run's teardown drops it. */
export async function withTestDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const name = `${prefix}${randomBytes(4).toString("hex")}`;
  await admin((c) => c.query(`CREATE DATABASE ${name}`));
  const url = urlFor(name);
  const { db, pool } = createDb(url);
  try {
    await migrate(url);
    return await fn(db);
  } finally {
    await pool.end();
  }
}

const name = `${prefix}${randomBytes(4).toString("hex")}`;
await admin((c) => c.query(`CREATE DATABASE ${name}`));
const url = urlFor(name);
const handle = createDb(url);

afterAll(async () => {
  await handle.pool.end();
});

await migrate(url);
await handle.pool.query(
  `insert into "user" (id, name, email) values ('user-1', 'User 1', 'user-1@example.com')`,
);

export const testDb: { db: Db; pool: pg.Pool } = handle;
