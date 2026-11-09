import "./telemetry.ts";
import { createDb } from "@keelson/db";
import { task } from "@renderinc/sdk/workflows";
import { pino } from "pino";
import { createPublicClient, http } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { z } from "zod";
import { type EvaluateDeps, evaluateDispute } from "./disputes/evaluate.ts";
import { createKv } from "./kv.ts";
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
});

let deps: Promise<EvaluateDeps> | undefined;

/** The connections a run needs, opened by the first run on an instance. */
async function connect(): Promise<EvaluateDeps> {
  const env = Env.parse(process.env);
  const log = pino();
  const { db } = createDb(env.DATABASE_URL);
  return {
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
  };
}

/** Attributes a stored PayPal dispute into a `Verdict` both TEE legs signed. */
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
    return evaluateDispute(await deps, disputeId);
  },
);
