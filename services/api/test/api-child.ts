// The API as a separate process for the kill-point suite: the in-process app with the pipeline
// and its resumer, on the test database, listening on PORT. It prints `listening` when ready.
import { serve } from "@hono/node-server";
import { createDb } from "@keelson/db";
import { pino } from "pino";
import { createPublicClient, type Hex, http, type PublicClient } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { createApp } from "../src/app.ts";
import { createKv } from "../src/kv.ts";
import { operatorSigners } from "../src/operators/signer.ts";
import { createPayPalDeps } from "../src/paypal.ts";
import { startPipelineResumer } from "../src/sweeper.ts";
import { createTee } from "../src/tee/config.ts";
import { AGENT_ID, kmsRelayer, STORE } from "./pipeline-live.ts";
import { headerPrincipal, liveEnv } from "./tee-live.ts";

const log = pino({ level: "info" });
const { db } = createDb(process.env.DATABASE_URL as string);
const kv = await createKv(process.env.REDIS_URL as string, log);
const client = createPublicClient({
  chain: arbitrumSepolia,
  transport: http(process.env.ARBITRUM_SEPOLIA_RPC_URL),
}) as PublicClient;
const tlog = JSON.parse(process.env.TEST_TLOG as string);
const relayer = await kmsRelayer(db, log);
relayer.startReconciler();
const deps = {
  db,
  kv,
  log,
  tlog,
  relayer,
  operators: operatorSigners(AGENT_ID, process.env.KEELSON_OPERATOR_KEY as Hex),
  paypal: createPayPalDeps({
    PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID as string,
    PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET as string,
    PAYPAL_ENV: "sandbox",
    PAYPAL_MERCHANT_ID: STORE,
  }),
};
const app = createApp({
  ...deps,
  appOrigin: "https://app.keelson.finance",
  authenticate: headerPrincipal,
  tee: createTee(liveEnv(), { a: 10_000, b: 10_000 }),
  chains: { 421614: { client, logs: client } },
  requestTimeoutMs: 60_000,
});
startPipelineResumer({ ...deps, chain: { client } });
serve({ fetch: app.fetch, port: Number(process.env.PORT) }, () => log.info("listening"));
