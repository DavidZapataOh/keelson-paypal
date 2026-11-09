// Loads reflect-metadata before anything pulls in @keelson/attest (see tee/attest.ts).
import "./tee/attest.ts";
import "./telemetry.ts";
import Anthropic from "@anthropic-ai/sdk";
import { createDb } from "@keelson/db";
import { task } from "@renderinc/sdk/workflows";
import { pino } from "pino";
import { createPublicClient, http } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { z } from "zod";
import { type RunDeps, runDispute } from "./disputes/run.ts";
import { createKv } from "./kv.ts";
import { relayerFromEnv } from "./onchain/relayer.ts";
import { createPayPalDeps } from "./paypal.ts";
import { createTee } from "./tee/config.ts";

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
