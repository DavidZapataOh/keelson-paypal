// Loads reflect-metadata before anything pulls in @keelson/attest (see tee/attest.ts).
import "./tee/attest.ts";
import "./telemetry.ts";
import Anthropic from "@anthropic-ai/sdk";
import { createDb, operators } from "@keelson/db";
import { task } from "@renderinc/sdk/workflows";
import { pino } from "pino";
import { createPublicClient, http } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { z } from "zod";
import { type RunDeps, runDispute } from "./disputes/run.ts";
import { treasuryFromKey } from "./disputes/treasury.ts";
import { resetJudges } from "./judge.ts";
import { createKv } from "./kv.ts";
import { relayerFromEnv } from "./onchain/relayer.ts";
import { createPayPalDeps } from "./paypal.ts";
import "./redteam.ts";
import { calibrate, gradeOf } from "./risk.ts";
import { createTee } from "./tee/config.ts";
import { c3SaltKey, proveAnonymousMandate } from "./zk/c3.ts";

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
  return {
    // Settles on chain only with the relayer's KMS key.
    relayer: await relayerFromEnv(env, db, log),
    treasury: treasuryFromKey(env.KEELSON_TREASURY_KEY),
    db,
    kv: await createKv(env.REDIS_URL, log),
    log,
    paypal: createPayPalDeps(env),
    tee: createTee(env),
    // The chain's public RPC serves `eth_getLogs` over ranges that provider free tiers refuse.
    chain: {
      client: createPublicClient({
        chain: arbitrumSepolia,
        transport: http(env.ARBITRUM_SEPOLIA_RPC_URL),
      }),
      logs: createPublicClient({ chain: arbitrumSepolia, transport: http() }),
    },
    rpcUrl: env.ARBITRUM_SEPOLIA_RPC_URL,
    tlog: { url: env.LOG_URL, token: env.LOG_WRITE_TOKEN },
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
 * for an hour: the salt is never a task argument. The key is deleted once the proof is stored;
 * without it the mandate keeps no C3 proof.
 */
task(
  {
    name: "proveAnonymousMandate",
    retry: { maxRetries: 3, waitDurationMs: 2_000, backoffScaling: 2 },
    timeoutSeconds: 300,
    plan: "4c-8g",
  },
  async function proveC3(_ctx, mandateId: string) {
    deps ??= connect().catch((err: unknown) => {
      deps = undefined;
      throw err;
    });
    const { db, kv, log } = await deps;
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
    await kv.del(key);
    return { mandateId, proved: true };
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
