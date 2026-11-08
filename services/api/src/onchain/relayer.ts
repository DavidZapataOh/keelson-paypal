import { KMSClient } from "@aws-sdk/client-kms";
import type { Db } from "@keelson/db";
import {
  type ChainId,
  createRelayer,
  kmsAccount,
  type Relayer,
  type RelayerChainConfig,
} from "@keelson/relayer";
import type { Logger } from "pino";
import type { Env } from "../env.ts";

/** The relayer of every chain whose KMS key the environment names; undefined when it names none. */
export async function relayerFromEnv(env: Env, db: Db, log: Logger): Promise<Relayer | undefined> {
  if (!env.RELAYER_AWS_ACCESS_KEY_ID || !env.RELAYER_AWS_SECRET_ACCESS_KEY) return undefined;
  const client = new KMSClient({
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.RELAYER_AWS_ACCESS_KEY_ID,
      secretAccessKey: env.RELAYER_AWS_SECRET_ACCESS_KEY,
    },
  });
  const chains: Partial<Record<ChainId, RelayerChainConfig>> = {};
  if (env.RELAYER_KMS_KEY_SANDBOX && env.ARBITRUM_SEPOLIA_RPC_URL) {
    chains[421614] = {
      rpcUrl: env.ARBITRUM_SEPOLIA_RPC_URL,
      fallbackRpcUrls: ["https://sepolia-rollup.arbitrum.io/rpc"],
      account: await kmsAccount({ keyId: env.RELAYER_KMS_KEY_SANDBOX, client }),
    };
  }
  if (env.RELAYER_KMS_KEY_LIVE && env.ARBITRUM_ONE_RPC_URL) {
    chains[42161] = {
      rpcUrl: env.ARBITRUM_ONE_RPC_URL,
      fallbackRpcUrls: ["https://arb1.arbitrum.io/rpc"],
      account: await kmsAccount({ keyId: env.RELAYER_KMS_KEY_LIVE, client }),
    };
  }
  if (Object.keys(chains).length === 0) return undefined;
  return createRelayer({ db, log, chains });
}
