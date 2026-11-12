import { addresses, engineProofVerifierAbi, keelsonBondVaultAbi } from "@keelson/chain";
import { and, chainEvents, type Db, eq, isNull, purchases, sql } from "@keelson/db";
import { type Relayer, RelayerError } from "@keelson/relayer";
import type { Logger } from "pino";
import {
  BaseError,
  bytesToHex,
  concat,
  decodeFunctionData,
  type Hex,
  type PublicClient,
  toHex,
} from "viem";
import { countersigs } from "../onchain/validations.ts";
import type { CountersignJson } from "../tee/client.ts";
import { countersignMessage } from "../tee/coordinator.ts";
import { purchaseOfCoverage } from "./amber-court.ts";

const CHAIN_ID = 421614;
/** The attribution rules that blame a failed mandate field: R60, R61 and R62. */
const FIELD_RULES = new Set([60, 61, 62]);
/** `FIELD_BITS` an independent observation also fails: the amount and the variant. */
const OBSERVED_FIELDS = new Set([3, 9]);
/** The court's and the vault's reverts after which the slash can no longer be contested. */
const FINAL = new Set([
  "NotContestable",
  "NotAnEvaluationFault",
  "CountersignMismatch",
  "InvalidCountersignature",
  "VerdictMismatch",
  "VetoClosed",
  "NotQueued",
]);
/** Slashes contested per pass; the rest wait for the next one. */
const BATCH = 100;

type QueuedVerdict = { ruleId: number; fieldId: number };

/**
 * Whether a queued slash's verdict rests only on the countersigned evaluation failing a field:
 * an ALLOW passes every field, so the engine proof of that ALLOW contradicts it.
 */
export function contestable(v: QueuedVerdict): boolean {
  return FIELD_RULES.has(v.ruleId) && !OBSERVED_FIELDS.has(v.fieldId);
}

const brief = (err: unknown) =>
  err instanceof BaseError ? err.shortMessage : err instanceof Error ? err.message : String(err);

const revertName = (err: unknown) =>
  err instanceof RelayerError && err.code === "simulation-reverted"
    ? (err.detail as { error?: { name?: string } } | undefined)?.error?.name
    : undefined;

/**
 * Contests every queued slash the chain-events follower stored whose verdict blames the operator
 * for a field the purchase's proven engine evaluation passed: reads the verdict from the `slash`
 * call, the purchase's ALLOW and its countersignatures, checks that `EngineProofVerifier` holds
 * the proof of that ALLOW, and sends `EngineProofCourt.contest`, which vetoes the slash. A slash
 * whose proof is not recorded yet stays unhandled for the next pass, until its veto window closes.
 */
export async function contestQueuedSlashes(deps: {
  db: Db;
  log: Logger;
  relayer: Relayer;
  client: PublicClient;
}): Promise<number> {
  const { db, client, relayer, log } = deps;
  const court = addresses[CHAIN_ID].EngineProofCourt as Hex | undefined;
  if (!court) return 0;
  const rows = await db
    .select({
      txHash: chainEvents.txHash,
      logIndex: chainEvents.logIndex,
      args: chainEvents.args,
    })
    .from(chainEvents)
    .where(
      and(
        eq(chainEvents.chainId, CHAIN_ID),
        eq(chainEvents.name, "SlashQueued"),
        isNull(chainEvents.handledAt),
      ),
    )
    .orderBy(chainEvents.blockNumber)
    .limit(BATCH);
  let contested = 0;
  for (const row of rows) {
    const args = row.args as { disputeId: Hex; coverageId: Hex; readyAt: string };
    const handled = () =>
      db
        .update(chainEvents)
        .set({ handledAt: sql`now()` })
        .where(
          and(
            eq(chainEvents.chainId, CHAIN_ID),
            eq(chainEvents.txHash, row.txHash),
            eq(chainEvents.logIndex, row.logIndex),
          ),
        );
    try {
      if (Number(args.readyAt) <= Date.now() / 1000) {
        await handled();
        continue;
      }
      const tx = await client.getTransaction({ hash: bytesToHex(row.txHash) });
      const call = decodeFunctionData({ abi: keelsonBondVaultAbi, data: tx.input });
      if (call.functionName !== "slash") {
        await handled();
        continue;
      }
      const verdict = call.args[0];
      const purchaseId = purchaseOfCoverage(verdict.coverageId);
      if (verdict.disputeId !== args.disputeId || !contestable(verdict) || !purchaseId) {
        await handled();
        continue;
      }
      const [p] = await db
        .select({
          countersign: purchases.countersign,
          digest: purchases.countersignDigest,
        })
        .from(purchases)
        .where(eq(purchases.id, purchaseId));
      if (!p?.countersign || !p.digest) {
        await handled();
        continue;
      }
      const countersign = p.countersign as unknown as CountersignJson;
      const proven = await client.readContract({
        address: addresses[CHAIN_ID].EngineProofVerifier as Hex,
        abi: engineProofVerifierAbi,
        functionName: "proven",
        args: [toHex(p.digest)],
      });
      if (proven !== countersign.evalHash) continue;
      const sigs = await countersigs(db, purchaseId, p.digest);
      try {
        await relayer.submit({
          chainId: CHAIN_ID,
          contract: "EngineProofCourt",
          functionName: "contest",
          args: [verdict, countersignMessage(countersign), concat(sigs)],
          key: `EngineProofCourt.contest:${verdict.disputeId}`,
        });
        contested++;
        log.info(
          { disputeId: verdict.disputeId, purchaseId },
          "slash contested with the engine proof",
        );
      } catch (err) {
        const name = revertName(err);
        if (!name || !FINAL.has(name)) throw err;
        log.warn({ disputeId: verdict.disputeId, name }, "slash not contestable");
      }
      await handled();
    } catch (err) {
      log.warn({ disputeId: args.disputeId, err: brief(err) }, "slash not contested");
    }
  }
  return contested;
}
