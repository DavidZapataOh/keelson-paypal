// Loads reflect-metadata before anything pulls in @keelson/attest (see tee/attest.ts).
import { LithicIssuer } from "./cards/issuer.ts";
import "./tee/attest.ts";
import "./telemetry.ts";
import Anthropic from "@anthropic-ai/sdk";
import { serve } from "@hono/node-server";
import { createChainReader } from "@keelson/alibi/verify";
import { createDb } from "@keelson/db";
import { CertStore } from "@keelson/paypal";
import { Render } from "@renderinc/sdk";
import { identityToRecipient } from "age-encryption";
import { pino } from "pino";
import { Resend } from "resend";
import { createPublicClient } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { anchorCovered } from "./alibi/anchors.ts";
import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { projectAmberConvictions } from "./chain/amber-court.ts";
import { followChainEvents, isFinal, wssUrl } from "./chain/events.ts";
import {
  arbitrumSepoliaLogsTransport,
  arbitrumSepoliaTransport,
  POLLING_INTERVAL_MS,
  startRpcReport,
} from "./chain/rpc.ts";
import { createChannel3 } from "./channel3/client.ts";
import { operatorAgent, termsConsent } from "./compile-sources.ts";
import { type RunDeps, runDispute } from "./disputes/run.ts";
import { treasuryFromKey } from "./disputes/treasury.ts";
import { parseEnv } from "./env.ts";
import { startHoldMaintenance } from "./hold/maintenance.ts";
import { createKv } from "./kv.ts";
import { createLogger } from "./logger.ts";
import { authenticate } from "./middleware/auth.ts";
import type { Notifier } from "./notify/notifier.ts";
import { relayerFromEnv } from "./onchain/relayer.ts";
import { recordOutcomes, startValidationSweeper } from "./onchain/validations.ts";
import { operatorSigners } from "./operators/signer.ts";
import { startPayPalPoller } from "./paypal/poll.ts";
import { startPayPalEventWorker } from "./paypal/worker.ts";
import { createPayPalDeps } from "./paypal.ts";
import { appEmbedPage } from "./routes/embed-page.ts";
import { closeServer } from "./shutdown.ts";
import { startPipelineResumer, startPurchaseSweeper, startSettlementSweeper } from "./sweeper.ts";
import { createTee } from "./tee/config.ts";
import { engineSource } from "./tee/engine-source.ts";
import { startSignerRefresh } from "./tee/signers.ts";
import { startStampWorker } from "./timestamps/worker.ts";
import { c1c3Prover } from "./zk/c1c3.ts";
import { c3Prover } from "./zk/c3.ts";

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
// Reads and receipts go to the configured provider; `eth_getLogs` and the reconciler to the
// chain's public RPC first, which serves the ranges the provider's free tier refuses.
const chains = {
  [arbitrumSepolia.id]: {
    client: createPublicClient({
      chain: arbitrumSepolia,
      transport: arbitrumSepoliaTransport(env.ARBITRUM_SEPOLIA_RPC_URL),
      pollingInterval: POLLING_INTERVAL_MS,
    }),
    logs: createPublicClient({
      chain: arbitrumSepolia,
      transport: arbitrumSepoliaLogsTransport(env.ARBITRUM_SEPOLIA_RPC_URL),
    }),
  },
};
const relayer = await relayerFromEnv(env, db, log);
const treasury = treasuryFromKey(env.KEELSON_TREASURY_KEY);
const paypal = createPayPalDeps(env);
const certs = new CertStore(env.PAYPAL_ENV, {
  get: (key) => kv.get(key),
  set: async (key, pem, ttlSeconds) => {
    await kv.set(key, pem, { EX: ttlSeconds });
  },
});
const render =
  env.RENDER_API_KEY && env.DISPUTE_WORKFLOW
    ? new Render({ token: env.RENDER_API_KEY })
    : undefined;
// The API runs a stored dispute at once, so the money moves seconds after the webhook; the workflow
// is started too and is the durable retry. A dispute runs once per status, stage and response due
// date: every re-read of an open dispute starts it again, and Render answers a key it saw in the
// last 24 h with the run it started then. A new status, stage or request from PayPal (an escalated
// inquiry, more evidence asked) runs it again.
const disputeRun: RunDeps | undefined =
  tee && env.LOG_URL && env.LOG_WRITE_TOKEN
    ? {
        db,
        kv,
        log,
        paypal,
        tee,
        chain: chains[arbitrumSepolia.id],
        rpcUrl: env.ARBITRUM_SEPOLIA_RPC_URL,
        tlog: { url: env.LOG_URL, token: env.LOG_WRITE_TOKEN },
        relayer,
        treasury,
        finalized: isFinal(db, chains[arbitrumSepolia.id].logs),
        anthropic: env.ANTHROPIC_API_KEY
          ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
          : undefined,
      }
    : undefined;
const startDisputeWorkflow =
  render || disputeRun
    ? async (disputeId: string, revision: string) => {
        if (disputeRun) {
          void runDispute(disputeRun, disputeId)
            .then((run) => log.info({ disputeId, revision, run }, "dispute run"))
            .catch((err: unknown) =>
              log.warn({ err, disputeId, revision }, "dispute run failed; the workflow retries it"),
            );
        }
        if (render) {
          const run = await render.workflows.startTask(
            `${env.DISPUTE_WORKFLOW}/evaluateDispute`,
            [disputeId],
            { idempotencyKey: `evaluateDispute:${disputeId}:${revision}` },
          );
          log.info({ disputeId, revision, taskRunId: run.taskRunId }, "dispute workflow started");
        }
      }
    : undefined;
const proveC3 = c3Prover(
  { db, kv, log, relayer },
  render && env.DISPUTE_WORKFLOW ? { render, slug: env.DISPUTE_WORKFLOW } : undefined,
);
const proveC1C3 = c1c3Prover(
  { db, log },
  render && env.DISPUTE_WORKFLOW ? { render, slug: env.DISPUTE_WORKFLOW } : undefined,
);
const notifier: Notifier = {
  db,
  log,
  appOrigin: env.APP_ORIGIN,
  apiOrigin: new URL(env.BETTER_AUTH_URL).origin,
  verifyOrigin: env.VERIFY_ORIGIN,
  secret: env.BETTER_AUTH_SECRET,
  ...(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT
    ? {
        vapid: {
          subject: env.VAPID_SUBJECT,
          publicKey: env.VAPID_PUBLIC_KEY,
          privateKey: env.VAPID_PRIVATE_KEY,
        },
      }
    : {}),
  ...(env.RESEND_API_KEY ? { resend: new Resend(env.RESEND_API_KEY) } : {}),
};
const paypalEvents = startPayPalEventWorker({
  db,
  kv,
  log,
  paypal,
  startDisputeWorkflow,
  notifier,
});
const operators =
  env.KEELSON_OPERATOR_KEY && env.DEMO_AGENT_ID
    ? operatorSigners(env.DEMO_AGENT_ID, env.KEELSON_OPERATOR_KEY)
    : undefined;
const cards = env.LITHIC_API_KEY
  ? {
      issuer: new LithicIssuer(env.LITHIC_API_KEY),
      asaSecret: env.LITHIC_ASA_SECRET,
      webhookSecret: env.LITHIC_WEBHOOK_SECRET,
    }
  : undefined;
const app = createApp({
  db,
  kv,
  log,
  auth,
  appOrigin: env.APP_ORIGIN,
  ...(env.APP_ORIGIN ? { embedPage: appEmbedPage(env.APP_ORIGIN) } : {}),
  verifyOrigin: env.VERIFY_ORIGIN,
  // The public RPCs the browser verifier uses: a report never names the API's keyed RPC URL.
  alibiChain: createChainReader(),
  passkeyRpId: env.PASSKEY_RP_ID,
  authenticate: authenticate(auth, env.BETTER_AUTH_URL, kv),
  authBaseUrl: env.BETTER_AUTH_URL,
  demoAgentId: env.DEMO_AGENT_ID,
  judgeInvite: env.JUDGE_INVITE_CODE,
  rateLimit: { trustProxy: process.env.RENDER === "true" },
  shutdown: shutdown.signal,
  notifier,
  stamps,
  chains,
  paypal,
  paypalEvents,
  proveAnonymousMandate: proveC3,
  proveAnonymousPurchase: proveC1C3,
  ...(env.PAYPAL_WEBHOOK_ID ? { paypalWebhook: { webhookId: env.PAYPAL_WEBHOOK_ID, certs } } : {}),
  ...(cards ? { cards } : {}),
  ...(startDisputeWorkflow ? { startDisputeWorkflow } : {}),
  ...(operators ? { operators } : {}),
  ...(relayer ? { relayer } : {}),
  ...(env.CHANNEL3_API_KEY ? { channel3: createChannel3(env.CHANNEL3_API_KEY) } : {}),
  ...(env.PROVER_URL ? { prover: env.PROVER_URL } : {}),
  ...(env.CHANNEL3_WEBHOOK_SECRET ? { channel3WebhookSecret: env.CHANNEL3_WEBHOOK_SECRET } : {}),
  ...(tee
    ? {
        tee,
        compileSources: {
          engine: engineSource,
          consent: termsConsent,
          ...(env.DEMO_AGENT_ID ? { agent: operatorAgent(db, env.DEMO_AGENT_ID) } : {}),
        },
      }
    : {}),
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
const stopResumer = startPipelineResumer({
  db,
  kv,
  log,
  tee,
  paypal,
  operators,
  relayer,
  stamps,
  chain: chains[arbitrumSepolia.id],
  cardIssuer: cards?.issuer,
  proveAnonymousPurchase: proveC1C3,
  notifier,
  ...(env.LOG_URL && env.LOG_WRITE_TOKEN
    ? { tlog: { url: env.LOG_URL, token: env.LOG_WRITE_TOKEN } }
    : {}),
});
const stopHolds = startHoldMaintenance({ db, kv, log, paypal });
const poller = startPayPalPoller({
  db,
  kv,
  log,
  paypal,
  paypalEvents,
  startDisputeWorkflow,
  notifier,
});
const stopReconciler = relayer?.startReconciler();
const sweeperDeps = relayer
  ? { db, log, relayer, operators, chain: chains[arbitrumSepolia.id] }
  : undefined;
const stopValidations = sweeperDeps ? startValidationSweeper(sweeperDeps) : undefined;

const stopSettlements = relayer
  ? startSettlementSweeper({
      db,
      log,
      paypal,
      relayer,
      treasury,
      chain: chains[arbitrumSepolia.id],
      finalized: isFinal(db, chains[arbitrumSepolia.id].logs),
    })
  : undefined;

const anchorDeps =
  env.LOG_URL && env.LOG_WRITE_TOKEN
    ? {
        db,
        log,
        chain: chains[arbitrumSepolia.id],
        tlog: { url: env.LOG_URL, token: env.LOG_WRITE_TOKEN },
      }
    : undefined;
const chainEvents = followChainEvents({
  db,
  kv,
  log,
  logs: chains[arbitrumSepolia.id].logs,
  wss: wssUrl(env),
  async handle() {
    if (sweeperDeps) await recordOutcomes(sweeperDeps);
    if (anchorDeps) await anchorCovered(anchorDeps);
    await projectAmberConvictions({ db, log, client: chains[arbitrumSepolia.id].client });
  },
});

const stopRpcReport = startRpcReport(log);

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
  stopSettlements?.();
  stopResumer();
  stopHolds();
  stopReconciler?.();
  stopValidations?.();
  stopRpcReport();
  void closeServer(server, shutdown)
    .then(() =>
      Promise.all([stamps.stop(), poller.stop(), paypalEvents.stop(), chainEvents.stop()]),
    )
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
