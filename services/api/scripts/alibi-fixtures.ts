/**
 * Drives two sandbox purchases through the deployed pipeline, one countersigned by both legs and
 * one by the TDX leg alone, and prints each one's Alibi once both TSAs stamped its leaf, as
 * `ALIBI <id> <k>/<n> <base64 chunk>` lines for `packages/alibi/test/fixtures`. It runs where the API runs, on
 * the database and private log listener the API uses.
 *
 * The sandbox buyer approves the hold: in this process when it has a browser, otherwise the line
 * `APPROVE <order id> <return url>` asks for it and the script waits.
 */
import { randomBytes } from "node:crypto";
import { encodeAlibi, toBase64 } from "@keelson/alibi";
import { verifyAlibi } from "@keelson/alibi/verify";
import { cartHash } from "@keelson/core";
import { createDb } from "@keelson/db";
import { closeMandate } from "@keelson/mandate";
import { pino } from "pino";
import { ulid } from "ulid";
import { bytesToHex, createPublicClient, type Hex, http, type PublicClient } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { loadAlibi } from "../src/alibi/issue.ts";
import { createApp } from "../src/app.ts";
import { parseEnv } from "../src/env.ts";
import { createKv } from "../src/kv.ts";
import { relayerFromEnv } from "../src/onchain/relayer.ts";
import { operatorSigners } from "../src/operators/signer.ts";
import { call, createPayPalDeps } from "../src/paypal.ts";
import { LegClient } from "../src/tee/client.ts";
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const env = parseEnv();
if (!env.LOG_URL || !env.LOG_WRITE_TOKEN || !env.KEELSON_OPERATOR_KEY || !env.DEMO_AGENT_ID) {
  throw new Error("needs LOG_URL, LOG_WRITE_TOKEN, KEELSON_OPERATOR_KEY and DEMO_AGENT_ID");
}
const log = pino({ level: "warn" });
const { db, pool } = createDb(env.DATABASE_URL);
const kv = await createKv(env.REDIS_URL, log);
const client = createPublicClient({
  chain: arbitrumSepolia,
  transport: http(env.ARBITRUM_SEPOLIA_RPC_URL),
}) as PublicClient;
const paypal = createPayPalDeps(env);
const relayer = await relayerFromEnv(env, db, log);
if (!relayer) throw new Error("needs the relayer's KMS key");
const tee = createTee({
  TEE_A_URL: env.TEE_A_URL as string,
  TEE_B_URL: env.TEE_B_URL as string,
  KEELSON_TEE_TOKEN: env.KEELSON_TEE_TOKEN as string,
  ARBITRUM_SEPOLIA_RPC_URL: env.ARBITRUM_SEPOLIA_RPC_URL,
});
const base = {
  db,
  kv,
  log,
  appOrigin: env.APP_ORIGIN,
  authenticate: headerPrincipal,
  tlog: { url: env.LOG_URL, token: env.LOG_WRITE_TOKEN },
  relayer,
  operators: operatorSigners(env.DEMO_AGENT_ID, env.KEELSON_OPERATOR_KEY as Hex),
  chains: { 421614: { client, logs: client } },
  paypal,
  requestTimeoutMs: 60_000,
};
const app = createApp({ ...base, tee });
// Leg B unreachable: the real degraded path, TDX alone.
const legB = new LegClient("b", "http://127.0.0.1:9", env.KEELSON_TEE_TOKEN as string, 500);
const degraded = createApp({ ...base, tee: { ...tee, client: { a: tee.client.a, b: legB } } });
const post = async (
  via: ReturnType<typeof createApp>,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
) => {
  const res = await via.request(path, {
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
  const stored = await post(app, "/v1/mandates", asUser(sub), signed.body);
  if (stored.status !== 201) throw new Error(`mandate not stored: ${JSON.stringify(stored.out)}`);
  const mid = stored.out.id as string;
  const held = await post(app, `/v1/mandates/${mid}/hold`, asUser(sub));
  const orderId = held.out.orderId as string;
  try {
    const { approveOrder, payerActionUrl } = await import("@keelson/paypal/testing");
    const order = await call(paypal.paypal.orders.getOrder({ id: orderId }));
    await approveOrder(payerActionUrl(order), `${env.APP_ORIGIN}/mandates/${mid}`);
  } catch {
    const order = await call(paypal.paypal.orders.getOrder({ id: orderId }));
    const link = order.links?.find((l) => l.rel === "payer-action")?.href;
    console.log(`APPROVE ${orderId} ${link} ${env.APP_ORIGIN}/mandates/${mid}`);
    for (let i = 0; ; i++) {
      const o = await call(paypal.paypal.orders.getOrder({ id: orderId }));
      if (o.status === "APPROVED") break;
      if (i > 360) throw new Error("the hold was not approved in 30 minutes");
      await sleep(5_000);
    }
  }
  const authorized = await post(app, `/v1/mandates/${mid}/hold/authorize`, asUser(sub), {
    orderId,
  });
  if (authorized.status !== 200) {
    throw new Error(`hold not authorized: ${JSON.stringify(authorized.out)}`);
  }
  const authorizationId = authorized.out.authorizationId as string;

  for (const [mode, via] of [
    ["2of2", app],
    ["degraded", degraded],
  ] as const) {
    const cart = cartOf(100);
    const requestId = ulid();
    const res = await post(via, "/v1/countersign", asAgent, {
      authorizationId,
      closedMandate: await closeMandate(
        stored.out.openMandate as string,
        { requestId, cartHash: `sha256:${bytesToHex(cartHash(cart.cart)).slice(2)}` },
        signed.key,
      ),
      cart: cart.cart,
      unit: cart.unit,
      evidenceRoot: await evidence.upload(app, mid, cart.cart, asAgent),
    });
    let state = res.out.state as string;
    while (["COUNTERSIGNED", "LOGGED", "COVERED"].includes(state)) {
      await sleep(250);
      const view = await app.request(`/v1/purchases/${requestId}`, { headers: asAgent });
      state = ((await view.json()) as { state: string }).state;
    }
    console.log(`${mode} ${requestId} ${res.status} ${state}`);
    for (let i = 0; i < 120; i++) {
      const b = await loadAlibi(db, requestId);
      if (b && b.timestamps.length >= 2 && b.paypal.capture_id) {
        const report = await verifyAlibi(b);
        const failed = report.checks.filter((c) => c.status === "fail");
        console.log(`${requestId} ${report.verdict} ${JSON.stringify(failed)}`);
        // Log lines are cut at a few kilobytes, so the bundle goes out in numbered chunks.
        const text = toBase64(encodeAlibi(b));
        const n = Math.ceil(text.length / 3000);
        for (let k = 0; k < n; k++) {
          console.log(`ALIBI ${requestId} ${k + 1}/${n} ${text.slice(k * 3000, (k + 1) * 3000)}`);
        }
        break;
      }
      await sleep(5_000);
    }
  }
  await post(app, `/v1/mandates/${mid}/revoke`, asUser(sub));
  await passkey.close();
} finally {
  await evidence.close();
  await kv.close();
  await pool.end();
}
