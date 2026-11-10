import { cartHash } from "@keelson/core";
import { eq, purchases } from "@keelson/db";
import { closeMandate } from "@keelson/mandate";
import { pino } from "pino";
import { ulid } from "ulid";
import { bytesToHex, createPublicClient, type Hex, http, type PublicClient } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { createApp, type Deps } from "../src/app.ts";
import { operatorSigners } from "../src/operators/signer.ts";
import type { PipelineDeps } from "../src/pipeline/drive.ts";
import { createTee } from "../src/tee/config.ts";
import { refreshLeg } from "../src/tee/signers.ts";
import { EvidenceUploader } from "./evidence.ts";
import { holdHarness, sandbox } from "./hold-live.ts";
import { startLocalLog } from "./log-live.ts";
import { AGENT_ID, cartOf, demoOperator, kmsRelayer, seedDemoOperator } from "./pipeline-live.ts";
import { testDb, testDbUrl, testKv } from "./setup.ts";
import { asAgent, headerPrincipal, liveEnv, repeating } from "./tee-live.ts";

const DRIVEN = ["COUNTERSIGNED", "LOGGED", "COVERED"];

/**
 * The API in this process wired to the live legs, a local log on the test database, Arbitrum
 * Sepolia through the KMS relayer and the PayPal sandbox, with helpers that open a held mandate
 * and countersign carts on it. `degraded` is the same API with leg B unreachable.
 */
export async function pipelineHarness(
  extra: Pick<Deps, "auth" | "authenticate" | "compileSources" | "anthropic"> = {},
) {
  const log = pino({ level: process.env.HARNESS_LOG ?? "silent" });
  const tee = createTee(liveEnv(), { a: 10_000, b: 10_000 });
  const degradedTee = createTee(
    { ...liveEnv(), TEE_B_URL: "http://127.0.0.1:9" },
    { a: 10_000, b: 500 },
  );
  await refreshLeg(testDb, "a", tee);
  await refreshLeg(testDb, "b", tee);
  await seedDemoOperator(testDb);
  const tlog = await startLocalLog(testDbUrl);
  const relayer = await kmsRelayer(testDb, log);
  const paypal = sandbox();
  const client = createPublicClient({
    chain: arbitrumSepolia,
    transport: http(process.env.ARBITRUM_SEPOLIA_RPC_URL),
  }) as PublicClient;
  const operators = operatorSigners(AGENT_ID, process.env.KEELSON_OPERATOR_KEY as Hex);
  const tlogConfig = { url: tlog.url, token: tlog.token, vkeys: tlog.vkeys };
  const appWith = (t: typeof tee) =>
    createApp({
      db: testDb,
      kv: testKv,
      log,
      appOrigin: "https://app.keelson.finance",
      authenticate: headerPrincipal,
      ...extra,
      tee: t,
      tlog: tlogConfig,
      relayer,
      operators,
      chains: { 421614: { client, logs: client } },
      paypal,
      requestTimeoutMs: 60_000,
    });
  const app = appWith(tee);
  const degraded = appWith(degradedTee);
  const deps: PipelineDeps = {
    db: testDb,
    kv: testKv,
    log,
    tlog: tlogConfig,
    relayer,
    operators,
    chain: { client },
    paypal,
  };
  const holds = holdHarness(app, paypal);
  const evidence = new EvidenceUploader();
  const opened: string[] = [];

  /** A new user's mandate of `maxMinor` for the demo operator, held and authorized on PayPal. */
  async function activeMandate(maxMinor: number) {
    const s = await holds.signed((m) => {
      m.payment.constraints = m.payment.constraints.map((c) =>
        c.type === "payment.budget" || c.type === "payment.amount_range"
          ? { ...c, max: maxMinor }
          : c,
      );
    }, demoOperator);
    const held = await holds.activate(s.sub, s.mid);
    opened.push(held.authorizationId);
    return { ...s, ...held };
  }

  type Mandate = Awaited<ReturnType<typeof activeMandate>>;

  /** Countersigns a cart of `minor` on `m`, through `via` (the 2-of-2 API by default). */
  async function countersign(m: Mandate, minor: number, via = app) {
    const requestId = ulid();
    const cart = cartOf(minor);
    const body = {
      authorizationId: m.authorizationId,
      closedMandate: await closeMandate(
        m.openMandate,
        { requestId, cartHash: `sha256:${bytesToHex(cartHash(cart.cart)).slice(2)}` },
        m.agentKey,
      ),
      cart: cart.cart,
      unit: cart.unit,
      evidenceRoot: await evidence.upload(app, m.mid, cart.cart, asAgent),
      ...(await repeating(testDb, m.mid, cart.cart, requestId)),
    };
    const started = performance.now();
    const res = await via.request("/v1/countersign", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": ulid(), ...asAgent },
      body: JSON.stringify(body),
    });
    const out = (await res.json()) as Record<string, unknown>;
    return { status: res.status, out, ms: performance.now() - started, requestId };
  }

  const purchase = async (id: string) =>
    (await testDb.select().from(purchases).where(eq(purchases.id, id)))[0];

  /** The purchase's state once its drive, which may outlive a `202`, has finished. */
  async function settled(id: string): Promise<string> {
    for (;;) {
      const p = await purchase(id);
      if (p && !DRIVEN.includes(p.state)) return p.state;
      if (p?.state === "COVERED" && p.leaseUntil === null) return p.state;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async function close() {
    for (const id of opened) await holds.release(id);
    await tlog.stop();
    await evidence.close();
  }

  return {
    app,
    degraded,
    deps,
    paypal,
    tlog,
    holds,
    evidence,
    activeMandate,
    countersign,
    purchase,
    settled,
    close,
  };
}
