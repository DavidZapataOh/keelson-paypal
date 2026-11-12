import pg from "pg";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** The prefix of every database this run creates: one per test file. */
    databasePrefix: string;
  }
}

const STEM = "keelson_api_test_";

/** Whether a process with this id is running. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function dropWhere(url: string, keep: (name: string) => boolean): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ datname: string }>(
      "select datname from pg_database where starts_with(datname, $1)",
      [STEM],
    );
    for (const { datname } of rows) {
      if (!keep(datname)) await client.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
    }
  } finally {
    await client.end();
  }
}

/**
 * Each test file migrates a database of its own, and every one of them is dropped here, once the files have finished:
 * `DROP DATABASE` makes the server take an immediate checkpoint, which would stall the files still running.
 */
export default async function setup(project: TestProject) {
  const url = project.config.env.DATABASE_URL as string;
  const prefix = `${STEM}${process.pid}_`;
  // Databases of earlier runs whose process is gone: runs killed before their teardown.
  await dropWhere(url, (name) => alive(Number(name.slice(STEM.length).split("_")[0])));
  project.provide("databasePrefix", prefix);
  return () => dropWhere(url, (name) => !name.startsWith(prefix));
}
