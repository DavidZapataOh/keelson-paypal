import { performance } from "node:perf_hooks";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { migrate } from "../src/client.ts";
import { createQueries } from "../src/queries.ts";
import * as schema from "../src/schema/index.ts";
import { assertLocalHost } from "./host.ts";

const BUDGET_MS = 5;
const RUNS = 1000;
const WARMUP = 100;
const GUARDED_TABLES = new Set(["purchases", "mandates", "events"]);

const baseUrl = new URL(
  process.env.DATABASE_URL ?? "postgres://postgres:keelson@localhost:5432/keelson",
);
assertLocalHost(baseUrl.toString());

const benchDb = `keelson_bench_${process.pid}`;
const benchUrl = new URL(baseUrl);
benchUrl.pathname = `/${benchDb}`;

const id = (i: number): string => String(i).padStart(26, "0");

let pool: pg.Pool;
let captured: { sql: string; params: unknown[] } | undefined;
let queries: ReturnType<typeof createQueries>;
const results: { query: string; p95: number; median: number; seqScans: number; indexes: string }[] =
  [];

async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: baseUrl.toString() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function populate(p: pg.Pool): Promise<void> {
  await p.query(
    `insert into operators (agent_id, chain_id, agent_registry, name, cnf_jwk) values (1, 421614, 'eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e', 'bench', '{"kty":"OKP"}')`,
  );
  await p.query(`
    insert into "user" (id, name, email)
    select 'user-' || i, 'bench', 'user-' || i || '@example.com' from generate_series(0, 2499) i`);
  await p.query(`
    insert into mandates (id, user_id, operator_agent_id, state, currency, max_minor, remaining_minor,
                          merchant_ids, expires_at, mandate_hash, created_at)
    select lpad(i::text, 26, '0'), 'user-' || (i % 2500), 1, 'ACTIVE', 'USD', 1000000, 1000000 - (i % 1000),
           array['merchant-' || (i % 2000)], now() + interval '30 days',
           decode(md5(i::text) || md5('m' || i::text), 'hex'), now() - (25000 - i) * interval '1 minute'
    from generate_series(1, 25000) i`);
  await p.query(`
    insert into purchases (id, mandate_id, state, merchant_id, currency, amount_minor, cart_hash,
                           invoice_id, paypal_capture_id, created_at)
    select lpad(i::text, 26, '0'), lpad((1 + i % 25000)::text, 26, '0'),
           (enum_range(null::purchase_state))[1 + i % 16], 'merchant-' || (i % 2000), 'USD', 100 + i % 9900,
           decode(md5(i::text) || md5('p' || i::text), 'hex'), 'inv-' || i, 'cap-' || i,
           now() - (250000 - i) * interval '10 seconds'
    from generate_series(1, 250000) i`);
  await p.query(`
    insert into disputes (id, purchase_id, reason, raw, created_at)
    select 'dispute-' || i, lpad((i * 12)::text, 26, '0'), 'item_not_received', '{}'::jsonb,
           now() - (20000 - i) * interval '1 minute'
    from generate_series(1, 20000) i`);
  await p.query(`
    insert into events (channel, subject_id, payload, created_at)
    select 'channel-' || (i % 100), lpad((1 + i % 250000)::text, 26, '0'), '{}'::jsonb,
           now() - (1000000 - i) * interval '1 second'
    from generate_series(1, 1000000) i`);
  await p.query("analyze");
}

function indexes(node: Record<string, unknown>): string[] {
  const own = node["Index Name"] ? [node["Index Name"] as string] : [];
  return own.concat(((node.Plans as Record<string, unknown>[] | undefined) ?? []).flatMap(indexes));
}

function seqScans(node: Record<string, unknown>): number {
  let count =
    node["Node Type"] === "Seq Scan" && GUARDED_TABLES.has(node["Relation Name"] as string) ? 1 : 0;
  for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? []) {
    count += seqScans(child);
  }
  return count;
}

const rand = (n: number): number => 1 + Math.floor(Math.random() * n);

const cases: { name: string; run: () => Promise<unknown> }[] = [
  { name: "mandateById", run: () => queries.mandateById(id(rand(25000))) },
  { name: "mandatesByUser", run: () => queries.mandatesByUser(`user-${rand(2500) - 1}`, 20) },
  {
    name: "mandatesByUser (next page)",
    run: () => {
      const user = rand(2500) - 1;
      return queries.mandatesByUser(`user-${user}`, 20, id((user || 2500) + 2500 * rand(8)));
    },
  },
  { name: "purchaseById", run: () => queries.purchaseById(id(rand(250000))) },
  { name: "purchasesByMandate", run: () => queries.purchasesByMandate(id(rand(25000)), 20) },
  {
    name: "purchasesByMandate (next page)",
    run: () => {
      const mandate = rand(25000);
      return queries.purchasesByMandate(id(mandate), 20, id(mandate - 1 + 25000 * rand(8)));
    },
  },
  { name: "purchaseByInvoiceId", run: () => queries.purchaseByInvoiceId(`inv-${rand(250000)}`) },
  { name: "purchaseByCaptureId", run: () => queries.purchaseByCaptureId(`cap-${rand(250000)}`) },
  { name: "openPurchases", run: () => queries.openPurchases(50) },
  { name: "disputeById", run: () => queries.disputeById(`dispute-${rand(20000)}`) },
  {
    name: "eventsAfter",
    run: () => queries.eventsAfter(`channel-${rand(100) - 1}`, BigInt(rand(990000)), 100),
  },
];

beforeAll(async () => {
  await withAdmin((c) => c.query(`create database ${benchDb}`));
  await migrate(benchUrl.toString());
  pool = new pg.Pool({ connectionString: benchUrl.toString(), max: 1 });
  await populate(pool);
  const db = drizzle(pool, {
    schema,
    casing: "snake_case",
    logger: {
      logQuery(sql, params) {
        captured = { sql, params };
      },
    },
  });
  queries = createQueries(db);
});

afterAll(async () => {
  try {
    await pool?.end();
  } finally {
    await withAdmin((c) => c.query(`drop database if exists ${benchDb} with (force)`));
  }
  console.table(
    results.map((r) => ({
      query: r.query,
      "median ms": r.median.toFixed(3),
      "p95 ms": r.p95.toFixed(3),
      "seq scans": r.seqScans,
      indexes: r.indexes,
    })),
  );
});

describe("hot queries at 250k purchases", () => {
  for (const { name, run } of cases) {
    test(name, async () => {
      await run();
      const { sql, params } = captured as NonNullable<typeof captured>;
      const explain = await pool.query(
        `explain (analyze, format json) ${sql}`,
        params as unknown[],
      );
      const plan = explain.rows[0]["QUERY PLAN"][0].Plan as Record<string, unknown>;
      const scans = seqScans(plan);

      for (let i = 0; i < WARMUP; i++) await run();
      const samples: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        const start = performance.now();
        await run();
        samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      const p95 = samples[Math.ceil(RUNS * 0.95) - 1] as number;
      results.push({
        query: name,
        p95,
        median: samples[RUNS / 2] as number,
        seqScans: scans,
        indexes: indexes(plan).join(", "),
      });

      expect(scans, `${name} seq scan on a guarded table`).toBe(0);
      expect(p95, `${name} p95`).toBeLessThan(BUDGET_MS);
    });
  }
});
