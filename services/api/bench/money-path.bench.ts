// Tracing starts before anything below loads `pg`.
import "./spans.ts";
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { cartHash } from "@keelson/core";
import { createDb, eq, events, mandates, purchases } from "@keelson/db";
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
import { spans } from "./spans.ts";
import { stats, waterfall } from "./waterfall.ts";

// PURCHASES purchases of the demo cart at PRICE_MINOR cents (100) spread over HOLDS fresh mandates, each held on PayPal
// and approved by the sandbox buyer, CONCURRENCY at a time; every DEGRADED_EVERY-th one runs with
// leg B unreachable. Each is timed from POST /v1/countersign to a terminal state, against the live
// legs, the deployed log, Arbitrum Sepolia through the relayer and the PayPal sandbox, in-process
// on the database the log reads. Prints the per-step waterfall from the purchase spans as JSON
// and exits 1 if a purchase is not captured or the end-to-end p95 is over budget.
const PURCHASES = Number(process.env.PURCHASES ?? 40);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 1);
const HOLDS = Number(process.env.HOLDS ?? 1);
const DEGRADED_EVERY = Number(process.env.DEGRADED_EVERY ?? 0);
const BUDGET_P95_MS = 8_000;
const PRICE_MINOR = Number(process.env.PRICE_MINOR ?? 100);
/** With DURATION_S set, purchases keep starting until it has passed (PURCHASES at most). */
const DURATION_S = Number(process.env.DURATION_S ?? 0);
const TERMINAL_WAIT_MS = 120_000;

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
const teeEnv = {
  TEE_A_URL: env.TEE_A_URL as string,
  TEE_B_URL: env.TEE_B_URL as string,
  KEELSON_TEE_TOKEN: env.KEELSON_TEE_TOKEN as string,
  ARBITRUM_SEPOLIA_RPC_URL: env.ARBITRUM_SEPOLIA_RPC_URL,
};
const tee = createTee(teeEnv);
const appWith = (t: typeof tee) =>
  createApp({
    db,
    kv,
    log,
    appOrigin: env.APP_ORIGIN,
    authenticate: headerPrincipal,
    tee: t,
    tlog: { url: env.LOG_URL as string, token: env.LOG_WRITE_TOKEN as string },
    relayer,
    operators: operatorSigners(env.DEMO_AGENT_ID as bigint, env.KEELSON_OPERATOR_KEY as Hex),
    chains: { 421614: { client, logs: client } },
    paypal,
    requestTimeoutMs: 60_000,
  });
const app = appWith(tee);
// Leg B unreachable: the countersign falls back to leg A alone.
const degraded = appWith(
  createTee({ ...teeEnv, TEE_B_URL: "http://127.0.0.1:9" }, { a: 10_000, b: 500 }),
);
const post = async (path: string, headers: Record<string, string>, body?: unknown) => {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": ulid(), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, out: (await res.json()) as Record<string, unknown> };
};
const evidence = new EvidenceUploader();
const lag: number[] = [];
/** Every mandate this run stored, revoked at the end whatever state its hold reached. */
const opened: { sub: string; mid: string }[] = [];

interface Hold {
  sub: string;
  mid: string;
  openMandate: string;
  key: CryptoKey;
  authorizationId: string;
}

/** A new user's mandate covering `count` purchases, held and approved by the sandbox buyer. */
async function openHold(count: number): Promise<Hold> {
  const passkey = await SoftwarePasskey.create();
  const sub = `kls_usr_${randomBytes(8).toString("hex")}`;
  await seedUser(db, passkey, sub);
  const max = count * PRICE_MINOR;
  const signed = await signedMandate(passkey, sub, demoOperator, (m) => {
    m.mid = ulid();
    m.payment.constraints = m.payment.constraints.map((c) =>
      c.type === "payment.budget" || c.type === "payment.amount_range" ? { ...c, max } : c,
    );
  });
  await passkey.close();
  const stored = await post("/v1/mandates", asUser(sub), signed.body);
  if (stored.status !== 201) throw new Error(`mandate not stored: ${JSON.stringify(stored.out)}`);
  const mid = stored.out.id as string;
  opened.push({ sub, mid });
  const held = await post(`/v1/mandates/${mid}/hold`, asUser(sub));
  const orderId = held.out.orderId as string;
  try {
    const { approveOrder, payerActionUrl } = await import("@keelson/paypal/testing");
    const order = await call(paypal.paypal.orders.getOrder({ id: orderId }));
    await approveOrder(payerActionUrl(order), `${env.APP_ORIGIN}/mandates/${mid}`);
  } catch (err) {
    // Without a browser the run waits for someone to approve, only when asked to.
    if (process.env.MANUAL_APPROVAL !== "1") throw err;
    console.error(`APPROVE ${orderId} ${env.APP_ORIGIN}/mandates/${mid}`);
    for (let i = 0; ; i++) {
      const order = await call(paypal.paypal.orders.getOrder({ id: orderId }));
      if (order.status === "APPROVED") break;
      if (i > 360) throw new Error("the hold was not approved in 30 minutes");
      await sleep(5_000);
    }
  }
  const authorized = await post(`/v1/mandates/${mid}/hold/authorize`, asUser(sub), { orderId });
  if (authorized.status !== 200) {
    throw new Error(`hold not authorized: ${JSON.stringify(authorized.out)}`);
  }
  const authorizationId = authorized.out.authorizationId as string;
  console.error(`mandate ${mid}, order ${orderId}, authorization ${authorizationId}`);
  return {
    sub,
    mid,
    openMandate: stored.out.openMandate as string,
    key: signed.key,
    authorizationId,
  };
}

interface Result {
  id: string;
  mode: "2of2" | "degraded";
  status: number;
  state: string;
  ms: number;
  failure?: string;
}

const results: Result[] = [];
const holds: Hold[] = [];

async function purchase(h: Hold, mode: Result["mode"], evidenceRoot: string): Promise<Result> {
  const cart = cartOf(PRICE_MINOR);
  const requestId = ulid();
  const channel = principalChannel({ kind: "user", subject: h.sub }, `purchase:${requestId}`);
  const received = new Map<string, number>();
  await listener.subscribe(eventsChannel(channel), (id) => received.set(id, Date.now()));
  const body = {
    authorizationId: h.authorizationId,
    closedMandate: await closeMandate(
      h.openMandate,
      { requestId, cartHash: `sha256:${bytesToHex(cartHash(cart.cart)).slice(2)}` },
      h.key,
    ),
    cart: cart.cart,
    unit: cart.unit,
    evidenceRoot,
  };
  const started = Date.now();
  const res = await (mode === "degraded" ? degraded : app).request("/v1/countersign", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": ulid(), ...asAgent },
    body: JSON.stringify(body),
  });
  const out = (await res.json()) as Record<string, unknown>;
  let state = (out.state as string | undefined) ?? (res.status === 202 ? "COUNTERSIGNED" : "ERROR");
  let failure: string | undefined;
  while (["COUNTERSIGNED", "LOGGED", "COVERED"].includes(state)) {
    if (Date.now() - started > TERMINAL_WAIT_MS) break;
    await sleep(50);
    // Read from the database: polling the API would spend the client's rate limit.
    const [p] = await db
      .select({ state: purchases.state, reason: purchases.failureReason })
      .from(purchases)
      .where(eq(purchases.id, requestId));
    state = p?.state ?? state;
    if (state === "FAILED" && p?.reason) failure = p.reason;
  }
  const ended = Date.now();
  await sleep(200);
  await listener.unsubscribe(eventsChannel(channel));
  const rows = await db
    .select({ id: events.id, at: events.createdAt })
    .from(events)
    .where(eq(events.channel, channel));
  for (const r of rows) {
    const got = received.get(String(r.id));
    if (got !== undefined) lag.push(got - r.at.getTime());
  }
  if (res.status >= 400) failure ??= String(out.type ?? res.status);
  return {
    id: requestId,
    mode,
    status: res.status,
    state,
    ms: ended - started,
    ...(failure ? { failure } : {}),
  };
}

try {
  await refreshLeg(db, "a", tee);
  await refreshLeg(db, "b", tee);
  await seedDemoOperator(db);
  const perHold = Math.ceil(PURCHASES / HOLDS);
  for (let i = 0; i < HOLDS; i++) holds.push(await openHold(perHold));
  // The evidence of every purchase is captured first, one browser page at a time, so the
  // concurrent purchases are not also running a browser page each.
  const roots: string[] = [];
  const cart = cartOf(PRICE_MINOR).cart;
  for (let i = 0; i < PURCHASES; i++) {
    roots.push(await evidence.upload(app, (holds[i % HOLDS] as Hold).mid, cart, asAgent));
  }
  await evidence.close();

  let next = 0;
  const until = DURATION_S > 0 ? Date.now() + DURATION_S * 1000 : Number.POSITIVE_INFINITY;
  const worker = async () => {
    for (let i = next++; i < PURCHASES && Date.now() < until; i = next++) {
      const mode = DEGRADED_EVERY > 0 && (i + 1) % DEGRADED_EVERY === 0 ? "degraded" : "2of2";
      const r = await purchase(holds[i % HOLDS] as Hold, mode, roots[i] as string);
      results.push(r);
      console.error(
        `${results.length}/${PURCHASES} ${r.id} ${r.mode} ${r.status} ${r.state} ${r.ms} ms`,
      );
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const captured = results.filter((r) => r.state === "CAPTURED");
  const failures: Record<string, number> = {};
  for (const r of results.filter((r) => r.state !== "CAPTURED")) {
    const k = `${r.status} ${r.state} ${r.failure ?? ""}`.trim();
    failures[k] = (failures[k] ?? 0) + 1;
  }
  const remaining = await Promise.all(
    holds.map(async (h) => {
      const [m] = await db.select().from(mandates).where(eq(mandates.id, h.mid));
      return `${m?.remainingMinor}/${m?.maxMinor}`;
    }),
  );
  const summary = {
    run: {
      PURCHASES,
      CONCURRENCY,
      HOLDS,
      DEGRADED_EVERY,
      PRICE_MINOR,
      DURATION_S,
      commit: process.env.RENDER_GIT_COMMIT,
    },
    endToEnd: stats(captured.map((r) => r.ms)),
    endToEnd2of2: stats(captured.filter((r) => r.mode === "2of2").map((r) => r.ms)),
    endToEndDegraded: stats(captured.filter((r) => r.mode === "degraded").map((r) => r.ms)),
    sse: stats(lag),
    ...waterfall(spans.getFinishedSpans()),
    purchases: results.length,
    captured: captured.length,
    failures,
    remaining,
    authorizations: holds.map((h) => h.authorizationId),
  };
  console.log(JSON.stringify(summary));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Money path\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n`,
    );
  }
  if (captured.length < results.length || summary.endToEnd.p95 >= BUDGET_P95_MS) {
    process.exitCode = 1;
  }
} finally {
  for (const m of opened) {
    await post(`/v1/mandates/${m.mid}/revoke`, asUser(m.sub)).catch((err: unknown) =>
      console.error(`mandate ${m.mid} not revoked: ${String(err)}`),
    );
  }
  await evidence.close().catch(() => {});
  await listener.close();
  await kv.close();
  await pool.end();
}
