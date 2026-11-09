import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll } from "vitest";
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

/** Creates a fresh migrated database, runs `fn` against it and drops it. */
export async function withTestDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const name = `keelson_test_${process.pid}_${randomBytes(4).toString("hex")}`;
  await admin((c) => c.query(`CREATE DATABASE ${name}`));
  const url = urlFor(name);
  const { db, pool } = createDb(url);
  try {
    await migrate(url);
    return await fn(db);
  } finally {
    await pool.end();
    await dropDatabase(name);
  }
}

const name = `keelson_test_${process.pid}_${randomBytes(4).toString("hex")}`;
await admin((c) => c.query(`CREATE DATABASE ${name}`));
const url = urlFor(name);
const handle = createDb(url);

afterAll(async () => {
  await handle.pool.end();
  await dropDatabase(name);
});

await migrate(url);
await handle.pool.query(
  `insert into "user" (id, name, email) values ('user-1', 'User 1', 'user-1@example.com')`,
);

export const testDb: { db: Db; pool: pg.Pool } = handle;
