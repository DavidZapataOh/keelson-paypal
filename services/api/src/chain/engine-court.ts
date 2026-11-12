import { addresses, keelsonBondVaultAbi } from "@keelson/chain";
import { and, chainEvents, type Db, eq, isNull, sql } from "@keelson/db";
import { type Relayer, RelayerError } from "@keelson/relayer";
import type { Logger } from "pino";
import { BaseError, bytesToHex, decodeFunctionData, type Hex, type PublicClient } from "viem";

const CHAIN_ID = 421614;
/** The attribution rules that blame a failed mandate field: R60, R61 and R62. */
const FIELD_RULES = new Set([60, 61, 62]);
/** `FIELD_BITS` an independent observation also fails: the amount and the variant. */
const OBSERVED_FIELDS = new Set([3, 9]);
/** Reverts the next pass may clear: the countersign or its proof is not recorded yet. */
const PENDING = new Set(["NoCountersign", "NotProven"]);
/** Slashes contested per pass; the rest wait for the next one. */
const BATCH = 100;

/**
 * Whether the engine proof is complete evidence against a verdict, as `EngineProofCourt.covers`
 * decides: a field rule naming a field only the evaluation decides.
 *
 * @internal
 */
export function contestable(v: { ruleId: number; fieldId: number }): boolean {
  return FIELD_RULES.has(v.ruleId) && !OBSERVED_FIELDS.has(v.fieldId);
}

const brief = (err: unknown) =>
  err instanceof BaseError ? err.shortMessage : err instanceof Error ? err.message : String(err);

const revertName = (err: unknown) =>
  err instanceof RelayerError && err.code === "simulation-reverted"
    ? (err.detail as { error?: { name?: string } } | undefined)?.error?.name
    : undefined;

/**
 * Contests every queued slash the chain-events follower stored whose verdict the engine proof can
 * answer: reads the verdict from the `slash` call and sends `EngineProofCourt.contest`, which
 * vetoes the slash when the coverage's recorded countersign has a recorded SP1 proof. A slash
 * whose countersign or proof is not recorded yet stays unhandled for the next pass, until its veto
 * window closes.
 */
export async function contestQueuedSlashes(deps: {
  db: Db;
  log: Logger;
  relayer: Relayer;
  client: PublicClient;
}): Promise<number> {
  const { db, client, relayer, log } = deps;
  if (!addresses[CHAIN_ID].EngineProofCourt) return 0;
  const rows = await db
    .select({ txHash: chainEvents.txHash, logIndex: chainEvents.logIndex, args: chainEvents.args })
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
    const args = row.args as { disputeId: Hex; readyAt: string };
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
      const verdict = call.functionName === "slash" ? call.args[0] : undefined;
      if (!verdict || verdict.disputeId !== args.disputeId || !contestable(verdict)) {
        await handled();
        continue;
      }
      try {
        await relayer.submit({
          chainId: CHAIN_ID,
          contract: "EngineProofCourt",
          functionName: "contest",
          args: [verdict],
          key: `EngineProofCourt.contest:${verdict.disputeId}`,
        });
        contested++;
        log.info({ disputeId: verdict.disputeId }, "slash contested with the engine proof");
      } catch (err) {
        const name = revertName(err);
        if (name && PENDING.has(name)) continue;
        if (!name) throw err;
        log.warn({ disputeId: verdict.disputeId, name }, "slash not contestable");
      }
      await handled();
    } catch (err) {
      log.warn({ disputeId: args.disputeId, err: brief(err) }, "slash not contested");
    }
  }
  return contested;
}
