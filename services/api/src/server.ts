import "./telemetry.ts";
import Anthropic from "@anthropic-ai/sdk";
import { serve } from "@hono/node-server";
import { createDb } from "@keelson/db";
import { identityToRecipient } from "age-encryption";
import { pino } from "pino";
import { createPublicClient, http } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { createChannel3 } from "./channel3/client.ts";
import { parseEnv } from "./env.ts";
import { createKv } from "./kv.ts";
import { createLogger } from "./logger.ts";
import { authenticate } from "./middleware/auth.ts";
import { relayerFromEnv } from "./onchain/relayer.ts";
import { startValidationSweeper } from "./onchain/validations.ts";
import { closeServer } from "./shutdown.ts";
import { startPurchaseSweeper } from "./sweeper.ts";
import { createTee } from "./tee/config.ts";
import { engineSource } from "./tee/engine-source.ts";
import { startSignerRefresh } from "./tee/signers.ts";
import { startStampWorker } from "./timestamps/worker.ts";

const FORCE_EXIT_MS = 10_000;

const env = parseEnv();
const destination = pino.destination({ sync: false });
const log = createLogger(destination);
const { db, pool } = createDb(env.DATABASE_URL);
const kv = await createKv(env.REDIS_URL, log);
const auth = createAuth(db, env);
const shutdown = new AbortController();
const tee =
  env.TEE_A_URL && env.TEE_B_URL && env.KEELSON_TEE_TOKEN
    ? createTee({
        TEE_A_URL: env.TEE_A_URL,
        TEE_B_URL: env.TEE_B_URL,
        KEELSON_TEE_TOKEN: env.KEELSON_TEE_TOKEN,
        ARBITRUM_SEPOLIA_RPC_URL: env.ARBITRUM_SEPOLIA_RPC_URL,
        KEELSON_ISSUER_THUMBPRINT: env.KEELSON_ISSUER_THUMBPRINT,
        KEELSON_REGISTRAR_KEY: env.KEELSON_REGISTRAR_KEY,
      })
    : undefined;
// The environment sets both or neither; the identity must open what agents seal to the recipient.
if (env.KEELSON_EVIDENCE_AGE_IDENTITY && env.KEELSON_EVIDENCE_AGE_RECIPIENT) {
  const recipient = await identityToRecipient(env.KEELSON_EVIDENCE_AGE_IDENTITY);
  if (recipient !== env.KEELSON_EVIDENCE_AGE_RECIPIENT) {
    throw new Error("KEELSON_EVIDENCE_AGE_IDENTITY does not open KEELSON_EVIDENCE_AGE_RECIPIENT");
  }
}
const stamps = startStampWorker(
  { db, kv, log },
  {
    urls: {
      ...(env.TSA_DIGICERT_URL ? { digicert: env.TSA_DIGICERT_URL } : {}),
      ...(env.TSA_SIGSTORE_URL ? { sigstore: env.TSA_SIGSTORE_URL } : {}),
      ...(env.TSA_FREETSA_URL ? { freetsa: env.TSA_FREETSA_URL } : {}),
      ...(env.TSA_SECTIGO_URL ? { sectigo: env.TSA_SECTIGO_URL } : {}),
    },
  },
);
// The chain's public RPC serves `eth_getLogs` over ranges that provider free tiers refuse.
const chains = {
  [arbitrumSepolia.id]: {
    client: createPublicClient({
      chain: arbitrumSepolia,
      transport: http(env.ARBITRUM_SEPOLIA_RPC_URL),
    }),
    logs: createPublicClient({ chain: arbitrumSepolia, transport: http() }),
  },
};
const relayer = await relayerFromEnv(env, db, log);
const app = createApp({
  db,
  kv,
  log,
  auth,
  appOrigin: env.APP_ORIGIN,
  passkeyRpId: env.PASSKEY_RP_ID,
  authenticate: authenticate(auth, env.BETTER_AUTH_URL),
  rateLimit: { trustProxy: process.env.RENDER === "true" },
  shutdown: shutdown.signal,
  stamps,
  chains,
  ...(relayer ? { relayer } : {}),
  ...(env.CHANNEL3_API_KEY ? { channel3: createChannel3(env.CHANNEL3_API_KEY) } : {}),
  ...(env.CHANNEL3_WEBHOOK_SECRET ? { channel3WebhookSecret: env.CHANNEL3_WEBHOOK_SECRET } : {}),
  ...(tee ? { tee, compileSources: { engine: engineSource } } : {}),
  ...(env.KEELSON_EVIDENCE_AGE_IDENTITY
    ? { evidenceIdentity: env.KEELSON_EVIDENCE_AGE_IDENTITY }
    : {}),
  ...(env.ANTHROPIC_API_KEY ? { anthropic: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) } : {}),
  ...(env.LOG_URL && env.LOG_WRITE_TOKEN
    ? { tlog: { url: env.LOG_URL, token: env.LOG_WRITE_TOKEN } }
    : {}),
});

const stopRefresh = tee ? startSignerRefresh({ db, log, tee }) : undefined;
const stopSweeper = tee ? startPurchaseSweeper({ db, log }) : undefined;
const stopReconciler = relayer?.startReconciler();
const stopValidations = relayer
  ? startValidationSweeper({ db, kv, log, relayer, chain: chains[arbitrumSepolia.id] })
  : undefined;

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log.info({ port: info.port }, "listening");
});

process.once("SIGTERM", () => {
  setTimeout(() => {
    log.error("shutdown timed out");
    destination.flushSync();
    process.exit(1);
  }, FORCE_EXIT_MS).unref();
  stopRefresh?.();
  stopSweeper?.();
  stopReconciler?.();
  stopValidations?.();
  void closeServer(server, shutdown)
    .then(() => stamps.stop())
    .then(() => Promise.all([pool.end(), kv.close()]))
    .then(
      () => 0,
      (err: unknown) => {
        log.error({ err }, "shutdown failed");
        return 1;
      },
    )
    .then((code) => {
      destination.flushSync();
      process.exit(code);
    });
});
