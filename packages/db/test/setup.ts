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
 * Ends `pool` and waits until the server has closed every connection: `pool.end()` resolves first, and a forced drop
 * would terminate the connections still closing, which then report `57P01` to their clients.
 */
async function closePool(pool: pg.Pool): Promise<void> {
  let open = pool.totalCount;
  const closed = new Promise<void>((resolve) => {
    if (open === 0) resolve();
    pool.on("remove", () => {
      if (--open === 0) resolve();
    });
  });
  await pool.end();
  await closed;
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
    await closePool(pool);
    await admin((c) => c.query(`DROP DATABASE ${name} WITH (FORCE)`));
  }
}

const name = `keelson_test_${process.pid}_${randomBytes(4).toString("hex")}`;
await admin((c) => c.query(`CREATE DATABASE ${name}`));
const url = urlFor(name);
const handle = createDb(url);

afterAll(async () => {
  await closePool(handle.pool);
  await admin((c) => c.query(`DROP DATABASE ${name} WITH (FORCE)`));
});

await migrate(url);
await handle.pool.query(
  `insert into "user" (id, name, email) values ('user-1', 'User 1', 'user-1@example.com')`,
);

export const testDb: { db: Db; pool: pg.Pool } = handle;
