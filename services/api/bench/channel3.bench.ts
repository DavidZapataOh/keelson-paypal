import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type AgentView,
  compareChannel3,
  jcs,
  normalizeProduct,
  observationDocument,
  sha256,
  toHex,
} from "@keelson/core";
import { createDb, mandates, migrate, operators, user } from "@keelson/db";
import pg from "pg";
import { pino } from "pino";
import { ulid } from "ulid";
import { createApp } from "../src/app.ts";
import { createChannel3, type LookupResult } from "../src/channel3/client.ts";
import { createKv } from "../src/kv.ts";

// Measures the Channel3 observation: LOOKUPS real lookups across the SKU list (one credit each),
// the observation handler with Channel3 left out (its Server-Timing `app` part), the sizes of
// what is stored, and how much a lookup started with an evidence capture adds to the capture's
// wall time (OVERLAP_RUNS credits). On Render only the lookups run: the rest needs a throwaway
// database and a browser.
const LOOKUPS = Number(process.env.LOOKUPS ?? 60);
const HANDLER_RUNS = Number(process.env.HANDLER_RUNS ?? 1000);
const OVERLAP_RUNS = Number(process.env.OVERLAP_RUNS ?? 10);
const apiKey = process.env.CHANNEL3_API_KEY;
if (!apiKey) throw new Error("CHANNEL3_API_KEY is not set");

const percentile = (xs: number[], q: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
};
const summary = (xs: number[], digits = 0) =>
  `p50 ${percentile(xs, 0.5).toFixed(digits)} ms, p95 ${percentile(xs, 0.95).toFixed(digits)} ms (n=${xs.length})`;

const skus = JSON.parse(
  readFileSync(new URL("../channel3-skus.json", import.meta.url), "utf8"),
) as { url: string }[];

// Every request Channel3 receives is inspected: it must never carry a user identifier.
const inspected: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  if (headers.has("x-user-id")) throw new Error("a user identifier was sent to Channel3");
  return fetch(input, init);
};
const { lookup } = createChannel3(apiKey, undefined, inspected);

const agreeing = (url: string, res: LookupResult): AgentView => {
  const product = normalizeProduct(res.product);
  const host = new URL(url).hostname.replace(/^www\./, "");
  const offer = product.offers.find((o) => o.domain === host);
  return {
    contentHash: toHex(sha256(randomBytes(32))),
    url,
    ...(product.brand ? { brand: product.brand } : {}),
    priceMinor: offer?.priceMinor || "0",
    currency: "USD",
    available: offer?.availability === "InStock",
    selected: product.selected,
  };
};

const lookups: number[] = [];
const sizes = new Map<string, { document: number; raw: number }>();
for (let i = 0; i < LOOKUPS; i++) {
  const { url } = skus[i % skus.length] as { url: string };
  const started = Date.now();
  const res = await lookup(url);
  lookups.push(res.receivedAtMs - started);
  if (res.error) {
    console.log(`lookup ${url}: ${res.error}`);
    continue;
  }
  const view = agreeing(url, res);
  const product = normalizeProduct(res.product);
  const document = observationDocument({
    id: ulid(),
    url,
    requestedAtMs: started,
    receivedAtMs: res.receivedAtMs,
    status: "ok",
    httpStatus: res.status,
    responseSha256: toHex(sha256(res.raw)),
    product,
    agentView: view,
    comparison: compareChannel3(view, product),
  });
  sizes.set(url, { document: Buffer.byteLength(jcs(document)), raw: res.raw.length });
}
console.log(`Channel3 lookup, realtime fetch: ${summary(lookups)}`);
for (const [url, s] of sizes) {
  console.log(`  ${url}: document ${s.document} B, raw response ${s.raw} B`);
}

if (!process.env.RENDER) {
  const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:keelson@localhost:5432/keelson";
  const name = `keelson_c3_bench_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const u = new URL(baseUrl);
  u.pathname = `/${name}`;
  await migrate(u.toString());
  const { db, pool } = createDb(u.toString());
  const log = pino({ level: "silent" });
  const kv = await createKv(process.env.REDIS_URL ?? "redis://localhost:6379", log);
  try {
    const userId = `user-${ulid()}`;
    await db.insert(user).values({ id: userId, name: "Bench", email: `${userId}@example.test` });
    const [operator] = await db
      .insert(operators)
      .values({
        agentId: 1n,
        chainId: 421614,
        agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
        name: "bench",
        cnfJwk: {},
      })
      .returning();
    const mandateId = ulid();
    await db.insert(mandates).values({
      id: mandateId,
      userId,
      operatorAgentId: (operator as { agentId: bigint }).agentId,
      state: "ACTIVE",
      currency: "USD",
      maxMinor: 10_000n,
      remainingMinor: 10_000n,
      merchantIds: ["shopwss.com"],
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    // Channel3 refuses at once here, so the handler's own work is what is timed; the
    // comparison it skips on an unavailable lookup takes about a microsecond.
    const app = createApp({
      db,
      kv,
      log,
      rateLimit: { limit: 1_000_000 },
      authenticate: async (c, next) => {
        // A subject per request keeps the per-mandate observation limit out of the timing.
        c.set("principal", { kind: "client", subject: ulid(), scopes: ["countersign:write"] });
        await next();
      },
      channel3: createChannel3("unused-key", "http://127.0.0.1:9"),
    });
    const handler: number[] = [];
    const body = JSON.stringify({
      mandateId,
      url: (skus[0] as { url: string }).url,
      agentView: {
        contentHash: toHex(sha256(randomBytes(32))),
        priceMinor: "2000",
        currency: "USD",
        available: true,
        selected: [{ name: "Color", label: "Black" }],
      },
    });
    for (let i = 0; i < HANDLER_RUNS; i++) {
      const res = await app.request("/v1/observations/channel3", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": ulid() },
        body,
      });
      if (res.status !== 201) throw new Error(`observation failed: ${res.status}`);
      const timing = /app;dur=([0-9.]+)/.exec(res.headers.get("server-timing") ?? "");
      handler.push(Number(timing?.[1]));
    }
    console.log(`Observation handler, Channel3 excluded: ${summary(handler, 2)}`);
  } finally {
    await pool.end();
    await kv.close();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }

  const { StoreCapture, ageKeys } = await import("../test/evidence.ts");
  const store = new StoreCapture();
  const keys = await ageKeys();
  const url = (skus[0] as { url: string }).url;
  const added: number[] = [];
  const alone: number[] = [];
  try {
    await store.capture("product.html", keys);
    for (let i = 0; i < OVERLAP_RUNS; i++) {
      let t = performance.now();
      await store.capture("product.html", keys);
      const a = performance.now() - t;
      t = performance.now();
      await Promise.all([store.capture("product.html", keys), lookup(url)]);
      alone.push(a);
      added.push(performance.now() - t - a);
    }
  } finally {
    await store.close();
  }
  console.log(`Capture alone: ${summary(alone)}`);
  console.log(`Wall time a lookup adds to the capture it starts with: ${summary(added)}`);
}
