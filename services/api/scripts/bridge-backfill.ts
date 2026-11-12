// Bridges every v1 Alibi into a SCITT statement, oldest first: leg A signs each bridge statement
// over the v1 countersigned facts, the log registers it with a receipt, and its v2 bundle is stored
// beside the v1 one. Safe to run again: bridged Alibis are skipped.
//
// node services/api/scripts/bridge-backfill.ts [--limit n]
//
// Needs DATABASE_URL, TEE_A_URL, TEE_B_URL, KEELSON_TEE_TOKEN, ARBITRUM_SEPOLIA_RPC_URL,
// KEELSON_ISSUER_THUMBPRINTS, LOG_URL and LOG_WRITE_TOKEN.
import { parseArgs } from "node:util";
import { createDb } from "@keelson/db";
import { pino } from "pino";
import type { Hex } from "viem";
import { bridgeAlibi, unbridged } from "../src/alibi/bridge.ts";
import { createTee } from "../src/tee/config.ts";

const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};
const { values } = parseArgs({ options: { limit: { type: "string", default: "1000" } } });
const log = pino();
const { db, pool } = createDb(env("DATABASE_URL"));
const tee = createTee({
  TEE_A_URL: env("TEE_A_URL"),
  TEE_B_URL: env("TEE_B_URL"),
  KEELSON_TEE_TOKEN: env("KEELSON_TEE_TOKEN"),
  ARBITRUM_SEPOLIA_RPC_URL: env("ARBITRUM_SEPOLIA_RPC_URL"),
  KEELSON_ISSUER_THUMBPRINTS: env("KEELSON_ISSUER_THUMBPRINTS").split(",") as Hex[],
});
const tlog = { url: env("LOG_URL"), token: env("LOG_WRITE_TOKEN") };

const counts: Record<string, number> = {};
let failed = 0;
for (const id of await unbridged(db, Number(values.limit))) {
  try {
    const outcome = await bridgeAlibi({ db, log, tee, tlog }, id);
    counts[outcome] = (counts[outcome] ?? 0) + 1;
    if (outcome === "legs") break;
  } catch (err) {
    failed++;
    log.error({ err, purchaseId: id }, "bridge failed");
  }
}
log.info({ ...counts, failed }, "backfill done");
await pool.end();
process.exitCode = failed ? 1 : 0;
