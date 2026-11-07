import { randomBytes } from "node:crypto";
import { createDb, eq, mandates, migrate, user } from "@keelson/db";
import pg from "pg";
import { pino } from "pino";
import { ulid } from "ulid";
import { hexToBytes } from "viem";
import { createApp } from "../src/app.ts";
import { createKv } from "../src/kv.ts";
import { LegClient } from "../src/tee/client.ts";
import { createTee } from "../src/tee/config.ts";
import { countersign2of2 } from "../src/tee/coordinator.ts";
import { refreshLeg } from "../src/tee/signers.ts";
import { EvidenceUploader } from "../test/evidence.ts";
import {
  asAgent,
  asUser,
  carts,
  expectation,
  headerPrincipal,
  registerMandate,
  request,
  SoftwarePasskey,
  seedUser,
  signedMandate,
} from "../test/tee-live.ts";

// Sequential countersigns of the demo cart against the live legs and a real sandbox authorization.
// The legs are timed one by one; leg A's time includes its PayPal read, so its own time is
// taken from its health round trip, which has the same path and no PayPal.
const SAMPLES = Number(process.env.SAMPLES ?? 200);
const BUDGETS = { legs: 200 };
const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:keelson@localhost:5432/keelson";

const percentile = (xs: number[], q: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
};
const summary = (xs: number[]) =>
  `p50 ${percentile(xs, 0.5).toFixed(0)} ms, p95 ${percentile(xs, 0.95).toFixed(0)} ms, p99 ${percentile(xs, 0.99).toFixed(0)} ms`;

async function paypalRead(): Promise<number> {
  const base = "https://api-m.sandbox.paypal.com";
  const basic = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`,
  ).toString("base64");
  const { access_token: token } = (await (
    await fetch(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    })
  ).json()) as { access_token: string };
  const headers = { authorization: `Bearer ${token}` };
  const id = process.env.PAYPAL_AUTHORIZATION_CREATED;
  const started = performance.now();
  const auth = (await (
    await fetch(`${base}/v2/payments/authorizations/${id}`, { headers })
  ).json()) as { supplementary_data?: { related_ids?: { order_id?: string } } };
  const order = auth.supplementary_data?.related_ids?.order_id;
  if (order) await fetch(`${base}/v2/checkout/orders/${order}`, { headers });
  return performance.now() - started;
}

const name = `keelson_bench_${randomBytes(4).toString("hex")}`;
const admin = new pg.Client({ connectionString: baseUrl });
await admin.connect();
await admin.query(`CREATE DATABASE ${name}`);
const url = new URL(baseUrl);
url.pathname = `/${name}`;
await migrate(url.toString());
const { db, pool } = createDb(url.toString());
const kv = await createKv(
  process.env.REDIS_URL ?? "redis://localhost:6379",
  pino({ level: "silent" }),
);

try {
  // On Render the production timeouts apply; from a laptop the legs are too far for them.
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

  const timed = { a: [] as number[], b: [] as number[], total: [] as number[] };
  const wrap = (leg: "a" | "b"): LegClient => {
    const inner = tee.client[leg];
    const wrapped = Object.create(inner) as LegClient;
    wrapped.countersign = async (r) => {
      const started = performance.now();
      try {
        return await inner.countersign(r);
      } finally {
        timed[leg].push(performance.now() - started);
      }
    };
    return wrapped;
  };
  const deps = {
    db,
    kv,
    log: pino({ level: "silent" }),
    tee: { ...tee, client: { a: wrap("a"), b: wrap("b") } },
    verifyingContract: "0x0000000000000000000000000000000000000000" as const,
  };

  const passkey = await SoftwarePasskey.create();
  const agent = await registerMandate(tee.client.a, passkey);

  // $0.50 carts keep the $100 budget from running out within 200 requests.
  const cheap = structuredClone(carts.demo);
  for (const line of cheap.cart.lines) line.unit_minor = 50;
  cheap.unit.amount.value = "0.50";
  cheap.unit.amount.breakdown.item_total.value = "0.50";

  let denied = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const req = await request(agent, cheap, ulid());
    const started = performance.now();
    const out = await countersign2of2(deps, req, await expectation(agent, req));
    timed.total.push(performance.now() - started);
    if (out.countersign.decision !== "1") denied++;
  }

  const reads: number[] = [];
  for (let i = 0; i < 50; i++) reads.push(await paypalRead());
  const health = { a: [] as number[], b: [] as number[] };
  for (let i = 0; i < 100; i++) {
    for (const leg of ["a", "b"] as const) {
      const started = performance.now();
      await tee.client[leg].health();
      health[leg].push(performance.now() - started);
    }
  }

  console.log(`countersigns: ${SAMPLES} sequential, ${denied} denied`);
  console.log(`leg A (with its PayPal read): ${summary(timed.a)}`);
  console.log(`leg B: ${summary(timed.b)}`);
  console.log(`both legs together: ${summary(timed.total)}`);
  console.log(`PayPal read, token reused (50 samples): ${summary(reads)}`);
  console.log(`leg A health, no PayPal (100 samples): ${summary(health.a)}`);
  console.log(`leg B health (100 samples): ${summary(health.b)}`);
  // Leg A's own time is its health round trip (same network, gateway and TLS; the engine's
  // countersign compute is under 2 ms); leg B is timed directly.
  const legs = percentile(health.a, 0.95) + percentile(timed.b, 0.95);
  console.log(
    `both legs, PayPal read excluded (p95 A health + p95 B countersign): ${legs.toFixed(0)} ms, budget ${BUDGETS.legs} ms`,
  );

  // The whole route: POST /v1/countersign of the demo cart, through the app's middleware, the
  // database, the coordinator and both legs. Each sample is a new open mandate, which has a
  // budget of its own.
  const app = createApp({
    db,
    kv,
    log: pino({ level: "silent" }),
    appOrigin: "https://app.keelson.finance",
    authenticate: headerPrincipal,
    tee,
    requestTimeoutMs: 60_000,
  });
  const post = (path: string, body: unknown, headers: Record<string, string>, target = app) =>
    target.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": ulid(), ...headers },
      body: JSON.stringify(body),
    });
  const first = await signedMandate(passkey);
  await seedUser(db, passkey, first.sub);
  const created = await post("/v1/mandates", first.body, asUser(first.sub));
  if (created.status !== 201) throw new Error(`mandate not stored: ${created.status}`);
  const { id: mandateId } = (await created.json()) as { id: string };
  // Each countersign binds a root of its own, stored before the timed request.
  const evidence = new EvidenceUploader();
  const issue = async () => {
    const fresh = await registerMandate(tee.client.a, passkey);
    await db
      .insert(user)
      .values({ id: fresh.sub, name: "Bench", email: `${fresh.sub}@example.test` });
    await db
      .update(mandates)
      .set({
        userId: fresh.sub,
        openMandate: fresh.issued.open_mandate,
        mandateHash: Buffer.from(hexToBytes(fresh.issued.mandate_hash)),
      })
      .where(eq(mandates.id, mandateId));
    return fresh;
  };
  const routeBody = async (agent: Awaited<ReturnType<typeof issue>>) => {
    const r = await request(agent, carts.demo);
    return {
      authorizationId: r.authorization_id,
      closedMandate: r.closed_mandate,
      cart: r.cart,
      unit: r.unit,
      evidenceRoot: await evidence.upload(app, mandateId, r.cart, asAgent),
    };
  };

  const route: number[] = [];
  const modes: Record<string, number> = {};
  for (let i = 0; i < Number(process.env.ROUTE_SAMPLES ?? 40); i++) {
    const body = await routeBody(await issue());
    const started = performance.now();
    const res = await post("/v1/countersign", body, asAgent);
    route.push(performance.now() - started);
    const out = (await res.json()) as { decision?: string; mode?: string };
    const key = `${res.status} ${out.decision ?? "-"} ${out.mode ?? "-"}`;
    modes[key] = (modes[key] ?? 0) + 1;
  }
  console.log(
    `POST /v1/countersign, demo cart, in process (${route.length} samples): ${summary(route)}`,
  );
  console.log(`outcomes: ${JSON.stringify(modes)}`);
  await evidence.close();

  const edge: number[] = [];
  if (process.env.API_URL) {
    for (let i = 0; i < 110; i++) {
      const started = performance.now();
      await (await fetch(new URL("/health", process.env.API_URL))).arrayBuffer();
      if (i >= 10) edge.push(performance.now() - started);
    }
    console.log(
      `GET ${process.env.API_URL}/health from the same machine (100 samples): ${summary(edge)}`,
    );
  }

  // Leg B is a black hole: the first degraded answer takes the leg B timeout.
  const dead = new LegClient(
    "b",
    "http://10.255.255.1:9",
    process.env.KEELSON_TEE_TOKEN as string,
    500,
  );
  const degradedApp = createApp({
    db,
    kv,
    log: pino({ level: "silent" }),
    appOrigin: "https://app.keelson.finance",
    authenticate: headerPrincipal,
    tee: { ...tee, client: { a: tee.client.a, b: dead } },
    requestTimeoutMs: 60_000,
  });
  const degraded: number[] = [];
  for (let i = 0; i < 5; i++) {
    const body = await routeBody(await issue());
    const started = performance.now();
    const res = await post("/v1/countersign", body, asAgent, degradedApp);
    degraded.push(performance.now() - started);
    if (res.headers.get("keelson-countersign-mode") !== "degraded") {
      throw new Error(`expected a degraded countersign, got ${res.status}`);
    }
  }
  console.log(`first degraded answer, leg B unreachable (5 samples): ${summary(degraded)}`);
  await passkey.close();
} finally {
  await pool.end();
  await kv.close();
  await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
  await admin.end();
}
