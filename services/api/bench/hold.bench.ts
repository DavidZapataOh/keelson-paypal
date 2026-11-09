import { randomBytes } from "node:crypto";
import { createDb, migrate } from "@keelson/db";
import { approveOrder, payerActionUrl } from "@keelson/paypal/testing";
import pg from "pg";
import { pino } from "pino";
import { ulid } from "ulid";
import { createApp } from "../src/app.ts";
import { createKv } from "../src/kv.ts";
import { call, createPayPalDeps } from "../src/paypal.ts";
import {
  asUser,
  headerPrincipal,
  SoftwarePasskey,
  seedUser,
  signedMandate,
} from "../test/tee-live.ts";

// Sequential mandate holds on the PayPal sandbox, through the in-process API: each one is
// created, approved by the sandbox buyer (not timed), authorized and voided by revoking it.
const SAMPLES = Number(process.env.SAMPLES ?? 20);
const BUDGETS = { create: 1_200, authorize: 1_500, void: 1_200 };
const APP_ORIGIN = "https://app.keelson.finance";
/** The demo store: the account whose credentials create and capture holds. */
const STORE = "A4WCRYD5EYDF2";
const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:keelson@localhost:5432/keelson";

const percentile = (xs: number[], q: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
};
const summary = (xs: number[]) =>
  `p50 ${percentile(xs, 0.5).toFixed(0)} ms, p95 ${percentile(xs, 0.95).toFixed(0)} ms`;

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
  const paypal = createPayPalDeps({
    PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID as string,
    PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET as string,
    PAYPAL_ENV: "sandbox",
    PAYPAL_MERCHANT_ID: STORE,
  });
  const app = createApp({
    db,
    kv,
    log: pino({ level: "silent" }),
    appOrigin: APP_ORIGIN,
    authenticate: headerPrincipal,
    paypal,
    requestTimeoutMs: 60_000,
  });
  const post = async (path: string, sub: string, body?: unknown) => {
    const started = performance.now();
    const res = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": ulid(), ...asUser(sub) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const elapsed = performance.now() - started;
    const out = (await res.json()) as Record<string, unknown>;
    if (res.status !== 200 && res.status !== 201)
      throw new Error(`${path}: ${res.status} ${JSON.stringify(out)}`);
    return { elapsed, out };
  };

  const timed = { create: [] as number[], authorize: [] as number[], void: [] as number[] };
  for (let i = 0; i < SAMPLES; i++) {
    // Each user registers a passkey of their own.
    const passkey = await SoftwarePasskey.create();
    const sub = `kls_usr_${randomBytes(8).toString("hex")}`;
    await seedUser(db, passkey, sub);
    const mandate = await signedMandate(passkey, sub, undefined, (m) => {
      m.mid = ulid();
    });
    const { out: stored } = await post("/v1/mandates", sub, mandate.body);
    const mid = stored.id as string;

    const held = await post(`/v1/mandates/${mid}/hold`, sub);
    timed.create.push(held.elapsed);
    const orderId = held.out.orderId as string;
    const order = await call(paypal.paypal.orders.getOrder({ id: orderId }));
    await approveOrder(payerActionUrl(order), `${APP_ORIGIN}/mandates/${mid}`);

    const authorized = await post(`/v1/mandates/${mid}/hold/authorize`, sub, { orderId });
    timed.authorize.push(authorized.elapsed);

    const revoked = await post(`/v1/mandates/${mid}/revoke`, sub);
    if (revoked.out.state !== "REVOKED") throw new Error(`${mid} not revoked`);
    timed.void.push(revoked.elapsed);
    console.log(
      `${i + 1}/${SAMPLES} order ${orderId}, authorization ${authorized.out.authorizationId} voided`,
    );
    await passkey.close();
  }

  console.log(`mandate holds: ${SAMPLES} sequential`);
  console.log(
    `POST /hold (order create): ${summary(timed.create)}, p95 budget ${BUDGETS.create} ms`,
  );
  console.log(
    `POST /hold/authorize (authorize + checks): ${summary(timed.authorize)}, p95 budget ${BUDGETS.authorize} ms`,
  );
  console.log(
    `POST /revoke (void of the parent): ${summary(timed.void)}, p95 budget ${BUDGETS.void} ms`,
  );
} finally {
  await pool.end();
  await kv.close();
  await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
  await admin.end();
}
