import { randomBytes } from "node:crypto";
import { KMSClient } from "@aws-sdk/client-kms";
import { cartHash } from "@keelson/core";
import { createDb, eq, purchases } from "@keelson/db";
import { closeMandate } from "@keelson/mandate";
import { approveOrder, payerActionUrl } from "@keelson/paypal/testing";
import { createRelayer, kmsAccount } from "@keelson/relayer";
import { ulid } from "ulid";
import { bytesToHex, createPublicClient, type Hex, http, type PublicClient } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { createApp } from "../src/app.ts";
import { parseEnv } from "../src/env.ts";
import { createKv } from "../src/kv.ts";
import type { LogConfig } from "../src/log/append.ts";
import { createLogger } from "../src/logger.ts";
import { relayerFromEnv } from "../src/onchain/relayer.ts";
import { operatorSigners } from "../src/operators/signer.ts";
import { call, createPayPalDeps } from "../src/paypal.ts";
import { createTee } from "../src/tee/config.ts";
import { refreshLeg } from "../src/tee/signers.ts";
import { EvidenceUploader } from "./evidence.ts";
import { cartOf, demoOperator, seedDemoOperator } from "./pipeline-live.ts";
import {
  asAgent,
  asUser,
  headerPrincipal,
  SoftwarePasskey,
  seedUser,
  signedMandate,
} from "./tee-live.ts";

/**
 * Set in a one-off job of the API service: the tests that need the deployed log, which only the
 * private network reaches and which reads the service's own database, run there and nowhere else.
 */
export const onRender = process.env.MONEY_PATH_LIVE === "1";

const DRIVEN = ["COUNTERSIGNED", "LOGGED", "COVERED"];
/** Unreachable on purpose: nothing listens on the discard port. */
export const UNREACHABLE = "http://127.0.0.1:9";

export interface Hold {
  sub: string;
  mid: string;
  openMandate: string;
  key: CryptoKey;
  orderId: string;
  authorizationId: string;
}

/**
 * The API in this process on the service's database and Redis, with the live legs, the deployed
 * log, Arbitrum Sepolia through the relayer and the PayPal sandbox. `appWith` builds the same API
 * with one dependency swapped, for failure injection. Every mandate it opens is revoked by
 * `close`.
 */
export async function renderHarness() {
  const env = parseEnv();
  if (!env.LOG_URL || !env.LOG_WRITE_TOKEN || !env.KEELSON_OPERATOR_KEY || !env.DEMO_AGENT_ID) {
    throw new Error("needs LOG_URL, LOG_WRITE_TOKEN, KEELSON_OPERATOR_KEY and DEMO_AGENT_ID");
  }
  const log = createLogger();
  log.level = "warn";
  const { db, pool } = createDb(env.DATABASE_URL);
  const kv = await createKv(env.REDIS_URL, log);
  const chain = createPublicClient({
    chain: arbitrumSepolia,
    transport: http(env.ARBITRUM_SEPOLIA_RPC_URL),
  }) as PublicClient;
  const paypal = createPayPalDeps(env);
  const relayer = await relayerFromEnv(env, db, log);
  if (!relayer) throw new Error("needs the relayer's KMS key");
  const teeEnv = {
    TEE_A_URL: env.TEE_A_URL as string,
    TEE_B_URL: env.TEE_B_URL as string,
    KEELSON_TEE_TOKEN: env.KEELSON_TEE_TOKEN as string,
    ARBITRUM_SEPOLIA_RPC_URL: env.ARBITRUM_SEPOLIA_RPC_URL,
  };
  const tee = createTee(teeEnv);
  const tlog: LogConfig = { url: env.LOG_URL, token: env.LOG_WRITE_TOKEN };
  const operators = operatorSigners(env.DEMO_AGENT_ID as bigint, env.KEELSON_OPERATOR_KEY as Hex);

  /** The relayer of Arbitrum Sepolia with its KMS key, sending through `rpcUrl` alone. */
  const relayerOn = async (rpcUrl: string) =>
    createRelayer({
      db,
      log,
      chains: {
        421614: {
          rpcUrl,
          fallbackRpcUrls: [],
          account: await kmsAccount({
            keyId: env.RELAYER_KMS_KEY_SANDBOX as string,
            client: new KMSClient({
              region: env.AWS_REGION,
              credentials: {
                accessKeyId: env.RELAYER_AWS_ACCESS_KEY_ID as string,
                secretAccessKey: env.RELAYER_AWS_SECRET_ACCESS_KEY as string,
              },
            }),
          }),
        },
      },
    });

  const appWith = async (
    over: { teeA?: string; teeB?: string; logUrl?: string; rpcUrl?: string } = {},
  ) => {
    const t =
      over.teeA || over.teeB
        ? createTee(
            {
              ...teeEnv,
              ...(over.teeA ? { TEE_A_URL: over.teeA } : {}),
              ...(over.teeB ? { TEE_B_URL: over.teeB } : {}),
            },
            { a: over.teeA ? 500 : 10_000, b: over.teeB ? 500 : 10_000 },
          )
        : tee;
    const client = over.rpcUrl
      ? (createPublicClient({
          chain: arbitrumSepolia,
          transport: http(over.rpcUrl, { retryCount: 0 }),
        }) as PublicClient)
      : chain;
    return createApp({
      db,
      kv,
      log,
      appOrigin: env.APP_ORIGIN,
      authenticate: headerPrincipal,
      tee: t,
      tlog: over.logUrl ? { ...tlog, url: over.logUrl } : tlog,
      relayer: over.rpcUrl ? await relayerOn(over.rpcUrl) : relayer,
      operators,
      chains: { 421614: { client, logs: client } },
      paypal,
      requestTimeoutMs: 60_000,
    });
  };
  const app = await appWith();
  const evidence = new EvidenceUploader();
  const opened: { sub: string; mid: string }[] = [];

  const post = async (path: string, headers: Record<string, string>, body?: unknown) => {
    const res = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": ulid(), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, out: (await res.json()) as Record<string, unknown> };
  };

  await refreshLeg(db, "a", tee);
  await refreshLeg(db, "b", tee);
  const unseed = await seedDemoOperator(db);

  /** A new user's mandate of `maxMinor`, held on PayPal and approved by the sandbox buyer. */
  async function openHold(maxMinor: number): Promise<Hold> {
    const passkey = await SoftwarePasskey.create();
    const sub = `kls_usr_${randomBytes(8).toString("hex")}`;
    await seedUser(db, passkey, sub);
    const signed = await signedMandate(passkey, sub, demoOperator, (m) => {
      m.mid = ulid();
      m.payment.constraints = m.payment.constraints.map((c) =>
        c.type === "payment.budget" || c.type === "payment.amount_range"
          ? { ...c, max: maxMinor }
          : c,
      );
    });
    await passkey.close();
    const stored = await post("/v1/mandates", asUser(sub), signed.body);
    if (stored.status !== 201) throw new Error(`mandate not stored: ${JSON.stringify(stored.out)}`);
    const mid = stored.out.id as string;
    opened.push({ sub, mid });
    const held = await post(`/v1/mandates/${mid}/hold`, asUser(sub));
    const orderId = held.out.orderId as string;
    const order = await call(paypal.paypal.orders.getOrder({ id: orderId }));
    const returnUrl = `${env.APP_ORIGIN}/mandates/${mid}`;
    try {
      await approveOrder(payerActionUrl(order), returnUrl);
    } catch (err) {
      // Without the buyer's credentials here, someone approves it, only when asked to.
      if (process.env.MANUAL_APPROVAL !== "1") throw err;
      console.log(`APPROVE ${orderId} ${returnUrl}`);
      for (let i = 0; ; i++) {
        const o = await call(paypal.paypal.orders.getOrder({ id: orderId }));
        if (o.status === "APPROVED") break;
        if (i > 360) throw new Error("the hold was not approved in 30 minutes");
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
    const authorized = await post(`/v1/mandates/${mid}/hold/authorize`, asUser(sub), { orderId });
    if (authorized.status !== 200) {
      throw new Error(`hold not authorized: ${JSON.stringify(authorized.out)}`);
    }
    return {
      sub,
      mid,
      openMandate: stored.out.openMandate as string,
      key: signed.key,
      orderId,
      authorizationId: authorized.out.authorizationId as string,
    };
  }

  /** The `POST /v1/countersign` body for a cart of `minor` on `h`, under a new request id. */
  async function cartBody(h: Hold, minor: number, requestId = ulid()) {
    const cart = cartOf(minor);
    return {
      requestId,
      body: {
        authorizationId: h.authorizationId,
        closedMandate: await closeMandate(
          h.openMandate,
          { requestId, cartHash: `sha256:${bytesToHex(cartHash(cart.cart)).slice(2)}` },
          h.key,
        ),
        cart: cart.cart,
        unit: cart.unit,
        evidenceRoot: await evidence.upload(app, h.mid, cart.cart, asAgent),
      },
    };
  }

  type Api = Awaited<ReturnType<typeof appWith>>;

  /** Sends a countersign body through `via`, timing it. */
  async function send(via: Api, body: unknown, key = ulid()) {
    const started = performance.now();
    const res = await via.request("/v1/countersign", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key, ...asAgent },
      body: JSON.stringify(body),
    });
    const out = (await res.json()) as Record<string, unknown>;
    return { status: res.status, out, ms: performance.now() - started };
  }

  async function countersign(h: Hold, minor: number, via: Api = app) {
    const { requestId, body } = await cartBody(h, minor);
    return { requestId, ...(await send(via, body)) };
  }

  const purchase = async (id: string) =>
    (await db.select().from(purchases).where(eq(purchases.id, id)))[0];

  /**
   * The purchase's terminal state. A purchase left mid-way by an API built without a dependency
   * is resumed by the deployed service once its lease lapses, as by any other instance.
   */
  async function settled(id: string, timeoutMs = 180_000): Promise<string> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const p = await purchase(id);
      if (p && !DRIVEN.includes(p.state)) return p.state;
      if (Date.now() > until) return p?.state ?? "MISSING";
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async function close() {
    for (const m of opened) {
      await post(`/v1/mandates/${m.mid}/revoke`, asUser(m.sub)).catch((err: unknown) =>
        console.error(`mandate ${m.mid} not revoked: ${String(err)}`),
      );
    }
    await evidence.close();
    await unseed();
    await kv.close();
    await pool.end();
  }

  return {
    env,
    db,
    kv,
    paypal,
    tlog,
    app,
    appWith,
    post,
    openHold,
    cartBody,
    send,
    countersign,
    purchase,
    settled,
    close,
  };
}
