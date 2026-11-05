import { sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { testDb, withTestDb } from "./setup.ts";

test("runs on Postgres 18 or newer", async () => {
  const { rows } = await testDb.db.execute<{ v: number }>(
    sql`select current_setting('server_version_num')::int as v`,
  );
  expect(rows[0]?.v).toBeGreaterThanOrEqual(180000);
});

test("withTestDb provides an isolated database", async () => {
  const names = await withTestDb(async (db) => {
    const { rows } = await db.execute<{ d: string }>(sql`select current_database() as d`);
    return rows[0]?.d;
  });
  expect(names).toMatch(/^keelson_test_\d+_[0-9a-f]{8}$/);
});
