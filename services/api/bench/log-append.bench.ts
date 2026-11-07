import { randomBytes } from "node:crypto";
import type { Countersign } from "@keelson/core/eip712";
import { createDb, eq, mandates, migrate, teeSigners, user } from "@keelson/db";
import { leafBytes, leafFromCountersign, paypalRefCommit } from "@keelson/log";
import pg from "pg";
import { pino } from "pino";
import { ulid } from "ulid";
import type { Hex } from "viem";
import { hexToBytes } from "viem";
import { createApp } from "../src/app.ts";
import { createKv } from "../src/kv.ts";
import { appendLeaf, type LogConfig } from "../src/log/append.ts";
import { createTee } from "../src/tee/config.ts";
import { refreshLeg } from "../src/tee/signers.ts";
import { EvidenceUploader } from "../test/evidence.ts";
import { startLocalLog } from "../test/log-live.ts";
import {
  asUser,
  carts,
  headerPrincipal,
  registerMandate,
  request,
  SoftwarePasskey,
  seedUser,
  signedMandate,
} from "../test/tee-live.ts";

// Countersigns SAMPLES purchases through POST /v1/countersign with the live legs, then appends
// their leaves: half one at a time, half at 20 per second. On Render (LOG_URL over the private
// network) it uses DATABASE_URL as is, since the log reads that database; otherwise it
// creates a database and starts the log locally with throwaway keys.
const SAMPLES = Number(process.env.SAMPLES ?? 300);
const RATE = 20;
const BUDGET_P95_MS = 1250;
const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:keelson@localhost:5432/keelson";

const percentile = (xs: number[], q: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
};
const summary = (xs: number[]) =>
  `p50 ${percentile(xs, 0.5).toFixed(0)} ms, p95 ${percentile(xs, 0.95).toFixed(0)} ms, p99 ${percentile(xs, 0.99).toFixed(0)} ms`;

let url = baseUrl;
let stopLog: (() => Promise<void>) | undefined;
let created: string | undefined;
let tlog: LogConfig;
if (process.env.RENDER && process.env.LOG_URL) {
  tlog = { url: process.env.LOG_URL, token: process.env.LOG_WRITE_TOKEN as string };
} else {
  const name = `keelson_log_bench_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(baseUrl);
  u.pathname = `/${name}`;
  url = u.toString();
  created = name;
  await migrate(url);
  const local = await startLocalLog(url);
  tlog = { url: local.url, token: local.token, vkeys: local.vkeys };
  stopLog = local.stop;
}
const { db, pool } = createDb(url);
const kv = await createKv(
  process.env.REDIS_URL ?? "redis://localhost:6379",
  pino({ level: "silent" }),
);

try {
  const tee = createTee(
    {
      TEE_A_URL: process.env.TEE_A_URL as string,
      TEE_B_URL: process.env.TEE_B_URL as string,
      KEELSON_TEE_TOKEN: process.env.KEELSON_TEE_TOKEN as string,
      ARBITRUM_SEPOLIA_RPC_URL: process.env.ARBITRUM_SEPOLIA_RPC_URL,
    },
    process.env.RENDER ? undefined : { a: 10_000, b: 10_000 },
  );
  await refreshLeg(db, "a", tee);
  await refreshLeg(db, "b", tee);
  const app = createApp({
    db,
    kv,
    log: pino({ level: "silent" }),
    appOrigin: "https://app.keelson.finance",
    authenticate: headerPrincipal,
    tee,
    requestTimeoutMs: 60_000,
  });
  const post = (path: string, body: unknown, headers: Record<string, string>) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": ulid(), ...headers },
      body: JSON.stringify(body),
    });

  // The sandbox authorization names one mandate, so there is one mandate row. The route allows
  // a caller 60 countersigns of a mandate a minute, so each 50 purchases come from another agent.
  const passkey = await SoftwarePasskey.create();
  const first = await signedMandate(passkey);
  await seedUser(db, passkey, first.sub);
  const stored = await post("/v1/mandates", first.body, asUser(first.sub));
  if (stored.status !== 201) throw new Error(`mandate not stored: ${stored.status}`);
  const { id: mandateId } = (await stored.json()) as { id: string };
  const agent = await registerMandate(tee.client.a, passkey);
  await db
    .insert(user)
    .values({ id: agent.sub, name: "Bench", email: `${agent.sub}@example.test` });
  await db
    .update(mandates)
    .set({
      userId: agent.sub,
      openMandate: agent.issued.open_mandate,
      mandateHash: Buffer.from(hexToBytes(agent.issued.mandate_hash)),
    })
    .where(eq(mandates.id, mandateId));
  const asBenchAgent = (k: number) => ({
    "x-test-principal": JSON.stringify({
      kind: "client",
      subject: `bench-agent-${k}`,
      scopes: ["countersign:write", "evidence:write"],
    }),
  });

  // $0.30 carts keep the $100 budget from running out within 300 purchases.
  const cheap = structuredClone(carts.demo);
  for (const line of cheap.cart.lines) line.unit_minor = 30;
  cheap.unit.amount.value = "0.30";
  cheap.unit.amount.breakdown.item_total.value = "0.30";

  const measurement = async (address: Hex | null) => {
    if (address === null) return null;
    const [row] = await db
      .select({ m: teeSigners.measurement })
      .from(teeSigners)
      .where(eq(teeSigners.address, Buffer.from(hexToBytes(address))));
    return row?.m ?? null;
  };
  const salt = randomBytes(32);
  const evidence = new EvidenceUploader();
  const purchases: { id: string; leaf: Uint8Array; countersign: Record<string, string> }[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const r = await request(agent, cheap, ulid());
    const res = await post(
      "/v1/countersign",
      {
        authorizationId: r.authorization_id,
        closedMandate: r.closed_mandate,
        cart: r.cart,
        unit: r.unit,
        evidenceRoot: await evidence.upload(
          app,
          mandateId,
          r.cart,
          asBenchAgent(Math.floor(i / 50)),
        ),
      },
      asBenchAgent(Math.floor(i / 50)),
    );
    const out = (await res.json()) as {
      purchaseId: string;
      mode: "2of2" | "degraded";
      countersign: Record<string, string>;
      digest: Hex;
      signatures: { tdx: Hex; nitro: Hex | null };
      signers: { tdx: Hex; nitro: Hex | null };
    };
    if (res.status !== 200)
      throw new Error(`countersign ${i}: ${res.status} ${JSON.stringify(out)}`);
    const c = out.countersign;
    const message: Countersign = {
      requestId: c.requestId as Hex,
      mandateHash: c.mandateHash as Hex,
      mandateCommitment: c.mandateCommitment as Hex,
      cartHash: c.cartHash as Hex,
      agentId: BigInt(c.agentId as string),
      merchantId: c.merchantId as Hex,
      amount: BigInt(c.amount as string),
      currency: Number(c.currency),
      category: Number(c.category),
      evidenceRoot: c.evidenceRoot as Hex,
      evalHash: c.evalHash as Hex,
      policySetHash: c.policySetHash as Hex,
      decision: Number(c.decision),
      failedFieldsMask: Number(c.failedFieldsMask),
      issuedAt: Number(c.issuedAt),
      expiresAt: Number(c.expiresAt),
    };
    const leaf = leafBytes(
      leafFromCountersign(
        message,
        out.digest,
        out.mode,
        out.signatures,
        {
          tdx: (await measurement(out.signers.tdx)) as string,
          nitro: await measurement(out.signers.nitro),
        },
        paypalRefCommit(salt, `ORDER${i}`, `AUTH${i}`),
      ),
    );
    purchases.push({ id: out.purchaseId, leaf, countersign: c });
  }

  const deps = { db, tlog };
  const append = async (p: (typeof purchases)[number]) => {
    const started = performance.now();
    await appendLeaf(deps, p.id, p.leaf, p.countersign);
    return performance.now() - started;
  };
  const half = Math.floor(SAMPLES / 2);
  const sequential: number[] = [];
  for (const p of purchases.slice(0, half)) sequential.push(await append(p));
  const paced = await Promise.all(
    purchases.slice(half).map(
      (p, i) =>
        new Promise<number>((done, fail) => {
          setTimeout(() => append(p).then(done, fail), (i * 1000) / RATE);
        }),
    ),
  );
  const sizes = purchases.map((p) => p.leaf.length);
  console.log(`leaves: ${SAMPLES}, ${Math.min(...sizes)}–${Math.max(...sizes)} bytes`);
  console.log(`append, sequential (${sequential.length}): ${summary(sequential)}`);
  console.log(`append, ${RATE}/s (${paced.length}): ${summary(paced)}`);
  const p95 = percentile([...sequential, ...paced], 0.95);
  await evidence.close();
  console.log(`append p95 over all: ${p95.toFixed(0)} ms, budget ${BUDGET_P95_MS} ms`);
} finally {
  await pool.end();
  await kv.close();
  await stopLog?.();
  if (created) {
    const admin = new pg.Client({ connectionString: baseUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE ${created} WITH (FORCE)`);
    await admin.end();
  }
}
