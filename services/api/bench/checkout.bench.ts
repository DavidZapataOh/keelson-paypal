import { randomBytes } from "node:crypto";
import { cartHash, ulidToBytes32 } from "@keelson/core";
import { createDb, eq, events, mandates } from "@keelson/db";
import { closeMandate } from "@keelson/mandate";
import { ulid } from "ulid";
import { bytesToHex, createPublicClient, type Hex, http, type PublicClient } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { createApp } from "../src/app.ts";
import { parseEnv } from "../src/env.ts";
import { eventsChannel } from "../src/events.ts";
import { createKv } from "../src/kv.ts";
import { createLogger } from "../src/logger.ts";
import { relayerFromEnv } from "../src/onchain/relayer.ts";
import { operatorSigners } from "../src/operators/signer.ts";
import { call, createPayPalDeps } from "../src/paypal.ts";
import { principalChannel } from "../src/principal.ts";
import { createTee } from "../src/tee/config.ts";
import { refreshLeg } from "../src/tee/signers.ts";
import { EvidenceUploader } from "../test/evidence.ts";
import { cartOf, demoOperator, seedDemoOperator } from "../test/pipeline-live.ts";
import {
  asAgent,
  asUser,
  headerPrincipal,
  SoftwarePasskey,
  seedUser,
  signedMandate,
} from "../test/tee-live.ts";

// SAMPLES sequential $1 purchases of the demo cart on one ACTIVE $100 mandate, each timed from
// POST /v1/countersign to CAPTURED, with every step taken from its purchase event's commit time.
// It runs against the live legs, the log, Arbitrum Sepolia through the relayer and the PayPal
// sandbox, in-process on the database the log reads (as `log-append.bench.ts` does on Render).
// The sandbox buyer approves the hold: in this process when it has a browser, otherwise the line
// `APPROVE <order id>` asks for it and the bench waits until PayPal reports the order approved.
const SAMPLES = Number(process.env.SAMPLES ?? 30);
const BUDGET_P95_MS = 4_500;

const percentile = (xs: number[], q: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
};
const summary = (xs: number[]) =>
  `p50 ${percentile(xs, 0.5).toFixed(0)} ms, p95 ${percentile(xs, 0.95).toFixed(0)} ms, max ${Math.max(...xs).toFixed(0)} ms (n=${xs.length})`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const env = parseEnv();
if (!env.LOG_URL || !env.LOG_WRITE_TOKEN || !env.KEELSON_OPERATOR_KEY || !env.DEMO_AGENT_ID) {
  throw new Error(
    "the bench needs LOG_URL, LOG_WRITE_TOKEN, KEELSON_OPERATOR_KEY and DEMO_AGENT_ID",
  );
}
const log = createLogger();
log.level = "warn";
const { db, pool } = createDb(env.DATABASE_URL);
const kv = await createKv(env.REDIS_URL, log);
const listener = kv.duplicate();
await listener.connect();
const client = createPublicClient({
  chain: arbitrumSepolia,
  transport: http(env.ARBITRUM_SEPOLIA_RPC_URL),
}) as PublicClient;
const paypal = createPayPalDeps(env);
const relayer = await relayerFromEnv(env, db, log);
if (!relayer) throw new Error("the bench needs the relayer's KMS key");
const tee = createTee({
  TEE_A_URL: env.TEE_A_URL as string,
  TEE_B_URL: env.TEE_B_URL as string,
  KEELSON_TEE_TOKEN: env.KEELSON_TEE_TOKEN as string,
  ARBITRUM_SEPOLIA_RPC_URL: env.ARBITRUM_SEPOLIA_RPC_URL,
});
const app = createApp({
  db,
  kv,
  log,
  appOrigin: env.APP_ORIGIN,
  authenticate: headerPrincipal,
  tee,
  tlog: { url: env.LOG_URL, token: env.LOG_WRITE_TOKEN },
  relayer,
  operators: operatorSigners(env.DEMO_AGENT_ID, env.KEELSON_OPERATOR_KEY as Hex),
  chains: { 421614: { client, logs: client } },
  paypal,
  requestTimeoutMs: 60_000,
});
const post = async (path: string, headers: Record<string, string>, body?: unknown) => {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": ulid(), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, out: (await res.json()) as Record<string, unknown> };
};
const evidence = new EvidenceUploader();

try {
  await refreshLeg(db, "a", tee);
  await refreshLeg(db, "b", tee);
  await seedDemoOperator(db);
  const passkey = await SoftwarePasskey.create();
  const sub = `kls_usr_${randomBytes(8).toString("hex")}`;
  await seedUser(db, passkey, sub);
  const signed = await signedMandate(passkey, sub, demoOperator, (m) => {
    m.mid = ulid();
  });
  const stored = await post("/v1/mandates", asUser(sub), signed.body);
  if (stored.status !== 201) throw new Error(`mandate not stored: ${JSON.stringify(stored.out)}`);
  const mid = stored.out.id as string;
  const held = await post(`/v1/mandates/${mid}/hold`, asUser(sub));
  const orderId = held.out.orderId as string;
  try {
    const { approveOrder, payerActionUrl } = await import("@keelson/paypal/testing");
    const order = await call(paypal.paypal.orders.getOrder({ id: orderId }));
    await approveOrder(payerActionUrl(order), `${env.APP_ORIGIN}/mandates/${mid}`);
  } catch {
    console.log(`APPROVE ${orderId} ${env.APP_ORIGIN}/mandates/${mid}`);
    for (let i = 0; ; i++) {
      const order = await call(paypal.paypal.orders.getOrder({ id: orderId }));
      if (order.status === "APPROVED") break;
      if (i > 360) throw new Error("the hold was not approved in 30 minutes");
      await sleep(5_000);
    }
  }
  const authorized = await post(`/v1/mandates/${mid}/hold/authorize`, asUser(sub), { orderId });
  if (authorized.status !== 200)
    throw new Error(`hold not authorized: ${JSON.stringify(authorized.out)}`);
  const authorizationId = authorized.out.authorizationId as string;
  console.log(`mandate ${mid}, order ${orderId}, authorization ${authorizationId}`);

  const total: number[] = [];
  const countersigned: number[] = [];
  const parallel: number[] = [];
  const logged: number[] = [];
  const captured: number[] = [];
  const coverage: number[] = [];
  const lag: number[] = [];
  const outcomes: Record<string, number> = {};
  for (let i = 0; i < SAMPLES; i++) {
    const cart = cartOf(100);
    const requestId = ulid();
    const evidenceRoot = await evidence.upload(app, mid, cart.cart, asAgent);
    const channel = principalChannel({ kind: "user", subject: sub }, `purchase:${requestId}`);
    const received = new Map<string, number>();
    await listener.subscribe(eventsChannel(channel), (id) => received.set(id, Date.now()));
    const started = Date.now();
    const res = await post("/v1/countersign", asAgent, {
      authorizationId,
      closedMandate: await closeMandate(
        stored.out.openMandate as string,
        { requestId, cartHash: `sha256:${bytesToHex(cartHash(cart.cart)).slice(2)}` },
        signed.key,
      ),
      cart: cart.cart,
      unit: cart.unit,
      evidenceRoot,
    });
    let state = res.out.state as string;
    while (["COUNTERSIGNED", "LOGGED", "COVERED"].includes(state)) {
      await sleep(50);
      const view = await app.request(`/v1/purchases/${requestId}`, { headers: asAgent });
      state = ((await view.json()) as { state: string }).state;
    }
    const ended = Date.now();
    await sleep(200);
    await listener.unsubscribe(eventsChannel(channel));
    outcomes[`${res.status} ${state}`] = (outcomes[`${res.status} ${state}`] ?? 0) + 1;
    const rows = await db
      .select({ id: events.id, payload: events.payload, at: events.createdAt })
      .from(events)
      .where(eq(events.channel, channel))
      .orderBy(events.id);
    const at = (type: string) =>
      rows.find((r) => (r.payload as { type: string }).type === type)?.at.getTime();
    for (const r of rows) {
      const got = received.get(String(r.id));
      if (got !== undefined) lag.push(got - r.at.getTime());
    }
    const [c, l, v, k] = ["countersigned", "logged", "covered", "captured"].map((t) =>
      at(`purchase.${t}`),
    );
    if (state === "CAPTURED") total.push(ended - started);
    if (c) countersigned.push(c - started);
    if (c && l) logged.push(l - c);
    if (c && v) parallel.push(v - c);
    if (v && k) captured.push(k - v);
    const lock = await relayer.get(
      421614,
      `KeelsonBondVault.lockCoverage:${ulidToBytes32(requestId)}`,
    );
    if (lock?.latencyMs !== undefined) coverage.push(lock.latencyMs);
    console.log(`${i + 1}/${SAMPLES} ${requestId} ${res.status} ${state} ${ended - started} ms`);
  }
  const [m] = await db.select().from(mandates).where(eq(mandates.id, mid));
  console.log(
    `outcomes ${JSON.stringify(outcomes)}, remaining ${m?.remainingMinor} of ${m?.maxMinor}`,
  );
  console.log(
    `checkout POST /v1/countersign -> CAPTURED: ${summary(total)}, p95 budget ${BUDGET_P95_MS} ms`,
  );
  console.log(`countersign (both legs): ${summary(countersigned)}`);
  console.log(`log append (countersigned -> logged): ${summary(logged)}`);
  console.log(`coverage (lockCoverage submit -> confirmed): ${summary(coverage)}`);
  console.log(`log || coverage (countersigned -> covered): ${summary(parallel)}`);
  console.log(`capture (covered -> captured): ${summary(captured)}`);
  console.log(`SSE event lag (row commit -> notified): ${summary(lag)}`);
  await post(`/v1/mandates/${mid}/revoke`, asUser(sub));
  await passkey.close();
  if (total.length < SAMPLES || percentile(total, 0.95) >= BUDGET_P95_MS) process.exitCode = 1;
} finally {
  await evidence.close();
  await listener.close();
  await kv.close();
  await pool.end();
}
