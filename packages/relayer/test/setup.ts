import { randomBytes } from "node:crypto";
import { createDb, type Db, mandates, migrate, operators, purchases, user } from "@keelson/db";
import pg from "pg";
import { ulid } from "ulid";
import { afterAll } from "vitest";

const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:keelson@localhost:5432/keelson";

async function admin(statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: baseUrl });
  await client.connect();
  try {
    await client.query(statement);
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

await dropOrphans("keelson_relayer_test_");
const name = `keelson_relayer_test_${process.pid}_${randomBytes(4).toString("hex")}`;
await admin(`CREATE DATABASE ${name}`);
const url = new URL(baseUrl);
url.pathname = `/${name}`;
/** The connection string of this run's database, for child processes. */
export const testDbUrl = url.toString();
await migrate(testDbUrl);
const handle = createDb(testDbUrl);
export const testDb: Db = handle.db;

afterAll(async () => {
  await handle.pool.end();
  await admin(`DROP DATABASE ${name} WITH (FORCE)`);
});

/** A countersigned purchase in `mode`, whose id is the coverage id a `lockCoverage` must carry. */
export async function seedPurchase(db: Db, mode: "2of2" | "degraded"): Promise<string> {
  const userId = ulid();
  await db.insert(user).values({ id: userId, name: "Buyer", email: `${userId}@example.com` });
  const agentId = BigInt(`0x${randomBytes(6).toString("hex")}`);
  await db.insert(operators).values({
    agentId,
    chainId: 421614,
    agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
    name: "Operator",
    cnfJwk: {},
  });
  const mandateId = ulid();
  await db.insert(mandates).values({
    id: mandateId,
    userId,
    operatorAgentId: agentId,
    currency: "USD",
    maxMinor: 1000n,
    remainingMinor: 1000n,
    merchantIds: ["merchant"],
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  const id = ulid();
  await db.insert(purchases).values({
    id,
    mandateId,
    state: "COUNTERSIGNED",
    merchantId: "merchant",
    currency: "USD",
    amountMinor: 100n,
    cartHash: randomBytes(32),
    decision: 1,
    countersignMode: mode,
  });
  return id;
}
