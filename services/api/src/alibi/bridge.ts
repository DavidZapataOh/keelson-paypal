// Loads reflect-metadata before @keelson/alibi/verify pulls in @keelson/attest (see tee/attest.ts).
import "../tee/attest.ts";
import {
  type AlibiBundle,
  type AlibiBundleV2,
  alibiSchema,
  alibiSchemaV2,
  bridgeBundle,
} from "@keelson/alibi";
import { verifyAlibi } from "@keelson/alibi/verify";
import { CHAIN_IDS } from "@keelson/core/eip712";
import { alibis, and, asc, type Db, eq, isNotNull, isNull, purchases } from "@keelson/db";
import { LOG_ORIGINS, LogClient } from "@keelson/log";
import type { Logger } from "pino";
import { appendStatement, type LogConfig } from "../log/append.ts";
import type { CountersignJson } from "../tee/client.ts";
import { legSupportsStatements } from "../tee/coordinator.ts";
import type { TeeConfig } from "../tee/signers.ts";

export interface BridgeDeps {
  db: Db;
  log: Logger;
  tee: TeeConfig;
  tlog: LogConfig;
}

/** `bridged`; `v2`: the purchase has its own statement; `done`: bridged before; `legs`: leg A cannot yet. */
export type BridgeOutcome = "bridged" | "v2" | "done" | "legs" | "unissued";

/**
 * Carries a v1 Alibi into v2: leg A checks the v1 leaf against a fresh inclusion proof under its
 * own log key and the v1 countersign, signs the bridge statement, the log registers it, and its
 * v2 bundle is stored beside the v1 one. Running it again changes nothing.
 */
export async function bridgeAlibi(deps: BridgeDeps, purchaseId: string): Promise<BridgeOutcome> {
  const { db, tee, tlog } = deps;
  const [row] = await db
    .select({
      bundle: alibis.bundle,
      bridged: alibis.bridgeBundle,
      statement: purchases.statement,
      logIndex: purchases.logIndex,
      chainId: purchases.chainId,
    })
    .from(alibis)
    .innerJoin(purchases, eq(purchases.id, alibis.purchaseId))
    .where(eq(alibis.purchaseId, purchaseId));
  if (!row || row.logIndex === null) return "unissued";
  if (row.statement) return "v2";
  if (row.bridged) return "done";
  if (!(await legSupportsStatements({ tee }, "a"))) return "legs";

  const v1: AlibiBundle = alibiSchema.parse(row.bundle);
  const chainId = row.chainId ?? CHAIN_IDS.arbitrumSepolia;
  const origin = LOG_ORIGINS[chainId];
  if (!origin) throw new RangeError(`no log for chain ${chainId}`);
  const fresh = await new LogClient(tlog.url, tlog.token, origin, tlog.timeoutMs).prove(
    BigInt(row.logIndex),
  );
  const countersign = v1.tee.countersign as unknown as CountersignJson;
  const { statement } = await tee.client.a.bridge({
    leaf: v1.leaf,
    tlog_proof: fresh.proof,
    countersign,
    chain_id: chainId,
  });
  const registered = Buffer.from(statement, "base64");
  const appended = await appendStatement({ db, tlog }, purchaseId, registered, countersign);
  if (!appended.receipt) throw new Error("the log issued no receipt for the bridge");
  const bundle = bridgeBundle(v1, registered, [appended.receipt], appended.proof);
  const report = await verifyAlibi(bundle);
  const check = report.checks.find((c) => c.id === "scitt.statement");
  if (check?.status !== "pass") {
    throw new Error(`the bridge statement does not verify: ${check?.reason ?? "absent"}`);
  }
  await db
    .update(alibis)
    .set({ bridgeBundle: bundle })
    .where(and(eq(alibis.purchaseId, purchaseId), isNull(alibis.bridgeBundle)));
  deps.log.info({ purchaseId, index: String(appended.index) }, "alibi bridged");
  return "bridged";
}

/** The v1 Alibis not bridged yet, oldest first. */
export async function unbridged(db: Db, limit: number): Promise<string[]> {
  const rows = await db
    .select({ id: alibis.purchaseId })
    .from(alibis)
    .innerJoin(purchases, eq(purchases.id, alibis.purchaseId))
    .where(
      and(isNull(alibis.bridgeBundle), isNull(purchases.statement), isNotNull(purchases.logIndex)),
    )
    .orderBy(asc(alibis.createdAt))
    .limit(limit);
  return rows.map((r) => r.id);
}

/** The v2 bundle a v1 Alibi was bridged into, `null` before it is. */
export async function loadBridge(db: Db, purchaseId: string): Promise<AlibiBundleV2 | null> {
  const [row] = await db
    .select({ bundle: alibis.bridgeBundle })
    .from(alibis)
    .where(eq(alibis.purchaseId, purchaseId));
  return row?.bundle ? alibiSchemaV2.parse(row.bundle) : null;
}
