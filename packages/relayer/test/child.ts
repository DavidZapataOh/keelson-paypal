// A separate process that relays deposits through the library; tests kill it mid-flight or run two at once.
import { KMSClient } from "@aws-sdk/client-kms";
import { createDb } from "@keelson/db";
import { pino } from "pino";
import type { Hex, LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { kmsAccount } from "../src/kms.ts";
import { createRelayer } from "../src/relayer.ts";
import { AGENT_ID, ANVIL_KEY, depositArgs, funder } from "./fork.ts";

interface ChildConfig {
  dbUrl: string;
  rpcUrl: string;
  sequencerUrl?: string;
  amount: string;
  salts: Hex[];
  kms?: boolean;
}

const config = JSON.parse(process.env.RELAYER_CHILD ?? "{}") as ChildConfig;
const { db, pool } = createDb(config.dbUrl);
let account: LocalAccount = privateKeyToAccount(ANVIL_KEY);
if (config.kms) {
  const region = process.env.AWS_REGION ?? "us-west-2";
  account = await kmsAccount({
    keyId: process.env.RELAYER_KMS_KEY_SANDBOX as string,
    client: new KMSClient({
      region,
      credentials: {
        accessKeyId: process.env.RELAYER_AWS_ACCESS_KEY_ID as string,
        secretAccessKey: process.env.RELAYER_AWS_SECRET_ACCESS_KEY as string,
      },
    }),
  });
}
const relayer = createRelayer({
  db,
  log: pino({ level: "silent" }),
  chains: {
    421614: {
      rpcUrl: config.rpcUrl,
      account,
      ...(config.sequencerUrl ? { sequencerUrl: config.sequencerUrl } : {}),
    },
  },
});
const prepared = await Promise.all(
  config.salts.map((salt) => depositArgs(funder(), BigInt(config.amount), AGENT_ID, salt)),
);
const results = await Promise.all(
  prepared.map(async ({ nonce, args }) => {
    try {
      const r = await relayer.submit({
        chainId: 421614,
        contract: "KeelsonBondVault",
        functionName: "depositWithAuthorization",
        args,
        key: `KeelsonBondVault.deposit:${nonce}`,
      });
      return {
        id: r.id,
        status: r.status,
        hash: r.hash,
        nonce: r.nonce?.toString(),
        latencyMs: r.latencyMs,
      };
    } catch (err) {
      return { error: (err as { code?: string }).code ?? (err as Error).message };
    }
  }),
);
process.stdout.write(JSON.stringify(results));
await pool.end();
