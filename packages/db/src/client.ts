import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate as runMigrations } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "./schema/index.ts";

export type Db = NodePgDatabase<typeof schema>;

export function createDb(url: string): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool, { schema, casing: "snake_case" });
  return { db, pool };
}

export async function migrate(url: string): Promise<void> {
  const { db, pool } = createDb(url);
  try {
    await runMigrations(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
  } finally {
    await pool.end();
  }
}
