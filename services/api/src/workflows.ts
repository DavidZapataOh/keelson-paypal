// Loads reflect-metadata before anything pulls in @keelson/attest (see tee/attest.ts).
import "./tee/attest.ts";
import "./telemetry.ts";
import Anthropic from "@anthropic-ai/sdk";
import { createDb, operators } from "@keelson/db";
import { task } from "@renderinc/sdk/workflows";
import { pino } from "pino";
import { createPublicClient } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { z } from "zod";
import { isFinal } from "./chain/events.ts";
import {
  arbitrumSepoliaLogsTransport,
  arbitrumSepoliaTransport,
  POLLING_INTERVAL_MS,
} from "./chain/rpc.ts";
import { type RunDeps, runDispute } from "./disputes/run.ts";
import { treasuryFromKey } from "./disputes/treasury.ts";
import { resetJudges } from "./judge.ts";
import { createKv } from "./kv.ts";
import { relayerFromEnv } from "./onchain/relayer.ts";
import { createPayPalDeps } from "./paypal.ts";
import "./redteam.ts";
import { calibrate, gradeOf } from "./risk.ts";
import { createTee } from "./tee/config.ts";
import { awaitingC3, proveAnonymousPurchase } from "./zk/c1c3.ts";
import { c3SaltKey, proveAnonymousMandate, publishUserSetRoots } from "./zk/c3.ts";
import { proveEngine } from "./zk/engine.ts";

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  PAYPAL_CLIENT_ID: z.string().min(1),
  PAYPAL_CLIENT_SECRET: z.string().min(1),
  PAYPAL_ENV: z.enum(["sandbox", "production"]),
  PAYPAL_MERCHANT_ID: z.string().min(1),
  TEE_A_URL: z.url(),
  TEE_B_URL: z.url(),
  KEELSON_TEE_TOKEN: z.string().min(32),
  ARBITRUM_SEPOLIA_RPC_URL: z.url(),
  LOG_URL: z.url(),
  LOG_WRITE_TOKEN: z.string().min(32),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  RELAYER_AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
  RELAYER_AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  RELAYER_KMS_KEY_SANDBOX: z.string().min(1).optional(),
  KEELSON_TREASURY_KEY: z
    .custom<`0x${string}`>((v) => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v))
    .optional(),
  AWS_REGION: z.string().min(1).default("us-west-2"),
});

let deps: Promise<RunDeps> | undefined;

/** The connections a run needs, opened by the first run on an instance. */
async function connect(): Promise<RunDeps> {
  const env = Env.parse(process.env);
  const log = pino();
  const { db } = createDb(env.DATABASE_URL);
  const logs = createPublicClient({
    chain: arbitrumSepolia,
    transport: arbitrumSepoliaLogsTransport(env.ARBITRUM_SEPOLIA_RPC_URL),
  });
  return {
    // Settles on chain only with the relayer's KMS key.
    relayer: await relayerFromEnv(env, db, log),
    treasury: treasuryFromKey(env.KEELSON_TREASURY_KEY),
    db,
    kv: await createKv(env.REDIS_URL, log),
    log,
    paypal: createPayPalDeps(env),
    tee: createTee(env),
    // Reads and receipts go to the configured provider; `eth_getLogs` and the reconciler to the
    // chain's public RPC first, which serves the ranges the provider's free tier refuses.
    chain: {
      client: createPublicClient({
        chain: arbitrumSepolia,
        transport: arbitrumSepoliaTransport(env.ARBITRUM_SEPOLIA_RPC_URL),
        pollingInterval: POLLING_INTERVAL_MS,
      }),
      logs,
    },
    rpcUrl: env.ARBITRUM_SEPOLIA_RPC_URL,
    tlog: { url: env.LOG_URL, token: env.LOG_WRITE_TOKEN },
    finalized: isFinal(db, logs),
    anthropic: env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : undefined,
  };
}

/**
 * Attributes a stored PayPal dispute into a `Verdict` both TEE legs signed, settles it with the
 * party at fault, then answers PayPal. Started again whenever the dispute changes status or stage.
 * The API runs the same steps as soon as the dispute is stored; this run then finds them done, or
 * retries while the API's run holds the dispute, and takes over when that run failed.
 */
task(
  {
    name: "evaluateDispute",
    retry: { maxRetries: 5, waitDurationMs: 2_000, backoffScaling: 2 },
    timeoutSeconds: 300,
    plan: "flex",
  },
  async function evaluate(_ctx, disputeId: string) {
    deps ??= connect().catch((err: unknown) => {
      deps = undefined;
      throw err;
    });
    return runDispute(await deps, disputeId, { wait: true });
  },
);

/**
 * Proves C3 for a mandate the API just stored, with the commitment salt the API left in Valkey
 * for an hour (the salt is never a task argument), then publishes the proof's root, and any
 * earlier one not yet on chain, to `RegisteredUserSet`. The key is deleted once the proof is stored;
 * without it the mandate keeps no C3 proof.
 */
task(
  {
    name: "proveAnonymousMandate",
    retry: { maxRetries: 3, waitDurationMs: 2_000, backoffScaling: 2 },
    timeoutSeconds: 300,
    // The composition of purchases logged before the proof needs about 2.8 GB.
    plan: "4c-8g",
  },
  async function proveC3(_ctx, mandateId: string) {
    deps ??= connect().catch((err: unknown) => {
      deps = undefined;
      throw err;
    });
    const { db, kv, log, relayer } = await deps;
    const key = c3SaltKey(mandateId);
    const salt = await kv.get(key);
    if (!salt) return { mandateId, proved: false };
    try {
      await proveAnonymousMandate({ db, log }, mandateId, salt);
    } catch (err) {
      // An assertion the circuit cannot take never proves: drop the salt now, without retries.
      if (!(err instanceof RangeError)) throw err;
      await kv.del(key);
      log.warn({ err, mandateId }, "C3 cannot prove this mandate");
      return { mandateId, proved: false };
    }
    // A retry finds the proof stored and publishes again: the salt is kept until the root is on chain.
    if (relayer) await publishUserSetRoots({ db, relayer, log });
    await kv.del(key);
    // Purchases logged before this proof existed are composed now, on this instance.
    for (const purchaseId of await awaitingC3(db, mandateId)) {
      await proveAnonymousPurchase({ db, log }, purchaseId).catch((err: unknown) =>
        log.warn({ err, purchaseId }, "not composed"),
      );
    }
    return { mandateId, proved: true };
  },
);

/**
 * Composes a logged purchase's C1 proof with its mandate's C3 proof into one proof. The proofs are
 * public, so nothing secret reaches the task. About 2.8 GB and 11-13 s on four cores.
 */
task(
  {
    name: "proveAnonymousPurchase",
    retry: { maxRetries: 2, waitDurationMs: 5_000, backoffScaling: 2 },
    timeoutSeconds: 300,
    plan: "4c-8g",
  },
  async function composeC1C3(_ctx, purchaseId: string) {
    deps ??= connect().catch((err: unknown) => {
      deps = undefined;
      throw err;
    });
    const { db, log } = await deps;
    const started = Date.now();
    try {
      await proveAnonymousPurchase({ db, log }, purchaseId);
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      log.warn({ err, purchaseId }, "nothing to compose");
      return { purchaseId, proved: false };
    }
    return { purchaseId, proved: true, ms: Date.now() - started };
  },
);

/**
 * Proves in SP1 that the engine evaluation a disputed purchase was countersigned on gives its
 * `evalHash`, and records the Groth16 proof with `EngineProofVerifier`. The Succinct Prover
 * Network proves; this instance only simulates the program, waits and verifies the proof, so it
 * needs a fraction of the 45 GB a local proof does. Each attempt is a paid network request, so a
 * failure is not retried; the 50 minutes hold the network's 40 and two recording attempts.
 */
task(
  {
    name: "proveEngine",
    retry: { maxRetries: 0, waitDurationMs: 10_000 },
    timeoutSeconds: 50 * 60,
    plan: "2c-8g",
  },
  async function proveEngineTask(_ctx, purchaseId: string) {
    deps ??= connect().catch((err: unknown) => {
      deps = undefined;
      throw err;
    });
    const { db, log, relayer, chain } = await deps;
    if (!relayer) throw new Error("the relayer is not configured");
    const started = Date.now();
    try {
      const proof = await proveEngine({ db, log, relayer, chain: chain.client }, purchaseId);
      return { purchaseId, proved: true, tx: proof.tx, ms: Date.now() - started };
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      log.warn({ err, purchaseId }, "no engine input to prove");
      return { purchaseId, proved: false };
    }
  },
);

/**
 * Recalibrates the risk model from every finished red-team campaign and the verdicts' loss
 * ratios, then regrades every linked operator under it. Started nightly.
 */
task(
  { name: "refreshTrustGrades", timeoutSeconds: 600, plan: "flex" },
  async function refreshTrustGrades() {
    deps ??= connect().catch((err: unknown) => {
      deps = undefined;
      throw err;
    });
    const { db } = await deps;
    const calibration = await calibrate(db);
    if (!calibration) return { calibrated: false };
    const linked = await db.select({ agentId: operators.agentId }).from(operators);
    const grades: { agentId: string; grade: string; premiumBps: number; computeMs: number }[] = [];
    for (const { agentId } of linked) {
      const r = await gradeOf(db, agentId);
      if (r.kind === "graded") {
        grades.push({
          agentId: String(agentId),
          grade: r.grade.grade,
          premiumBps: r.grade.premium.bps,
          computeMs: r.grade.computeMs,
        });
      }
    }
    return {
      calibrated: true,
      calibration: calibration.id,
      campaigns: calibration.prior.campaigns,
      grades,
    };
  },
);

/**
 * Closes the Judge Mode tenants opened more than 12 hours ago: their open mandates are revoked
 * and their holds voided, their sessions end, and judges that own no mandate are deleted.
 * Started nightly.
 */
task(
  { name: "resetJudgeMode", timeoutSeconds: 300, plan: "starter" },
  async function resetJudgeMode() {
    deps ??= connect().catch((err: unknown) => {
      deps = undefined;
      throw err;
    });
    return resetJudges(await deps);
  },
);
