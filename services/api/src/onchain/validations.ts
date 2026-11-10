import { addresses, keelsonBondVaultAbi } from "@keelson/chain";
import { keelsonDomain } from "@keelson/core/eip712";
import {
  and,
  chainEvents,
  chainTxs,
  type Db,
  desc,
  eq,
  inArray,
  isNull,
  purchases,
  sql,
  teeSignatures,
  teeSigners,
} from "@keelson/db";
import { type Relayer, RelayerError, type TxRecord } from "@keelson/relayer";
import type { Logger } from "pino";
import { BaseError, concat, type Hex, type PublicClient, toHex } from "viem";
import { CHAIN_ID } from "../chain/events.ts";
import type { OperatorSigners } from "../operators/signer.ts";
import type { CountersignJson } from "../tee/client.ts";
import { countersignMessage } from "../tee/coordinator.ts";

const SWEEP_INTERVAL_MS = 10_000;
/** A countersign expires within minutes; one never covered by then never will be. */
const COVERABLE_FOR = "1 day";
/** A released or slashed coverage whose outcome still fails to record after this is left alone. */
const OUTCOME_WINDOW = "2 days";
/** Seconds past `releaseAfter` before a coverage is released; the vault's clock may trail. */
const RELEASE_MARGIN_S = 5;
const ALLOW = 1;
const DENY = 2;
/** Coverages are released within this long of their window closing; past it, by hand. */
const RELEASABLE_FOR = "2 days";
/** Reverts that no later state changes: the outcome is recorded, or there is no validation to update. */
const FINAL = new Set(["AlreadyRated", "OutcomeRecorded", "UnknownValidation"]);

export interface SweeperDeps {
  db: Db;
  log: Logger;
  relayer: Relayer;
  /** Reads the vault. */
  chain: { client: PublicClient };
  /** Signs the `ValidationRequest` of an operator's DENY purchases; DENY validations wait without it. */
  operators?: OperatorSigners | undefined;
}

/** The countersignatures of a purchase in the order the VerdictVerifier checks them: TDX, then Nitro. */
async function countersigs(db: Db, purchaseId: string, digest: Buffer): Promise<Hex[]> {
  const rows = await db
    .select({ kind: teeSigners.teeKind, signature: teeSignatures.signature })
    .from(teeSignatures)
    .innerJoin(teeSigners, eq(teeSigners.address, teeSignatures.signer))
    .where(and(eq(teeSignatures.requestId, purchaseId), eq(teeSignatures.digest, digest)))
    .orderBy(teeSigners.teeKind);
  return rows.map((r) => toHex(r.signature));
}

/** Only viem's short message: the full one carries the request URL, which embeds the provider's key. */
const brief = (err: unknown) =>
  err instanceof BaseError ? err.shortMessage : err instanceof Error ? err.message : String(err);

const isDone = (err: unknown, name: string) =>
  err instanceof RelayerError &&
  err.code === "simulation-reverted" &&
  (err.detail as { error?: { name?: string } } | undefined)?.error?.name === name;

/**
 * Records the ERC-8004 validation of every covered ALLOW purchase. A DENY needs the operator's own request
 * signature, which it sends itself.
 *
 * @internal
 */
export async function recordValidations(deps: SweeperDeps): Promise<number> {
  const { db, relayer, chain, log } = deps;
  const vault = addresses[CHAIN_ID].KeelsonBondVault as Hex;
  const candidates = await db
    .select({
      id: purchases.id,
      countersign: purchases.countersign,
      digest: purchases.countersignDigest,
      mode: purchases.countersignMode,
    })
    .from(purchases)
    .where(
      and(
        eq(purchases.decision, ALLOW),
        isNull(purchases.validationTxId),
        isNull(purchases.validationSkippedAt),
        sql`${purchases.countersign} is not null`,
        sql`${purchases.createdAt} > now() - ${COVERABLE_FOR}::interval`,
      ),
    )
    .orderBy(desc(purchases.createdAt))
    .limit(100);
  if (candidates.length === 0) return 0;
  const coverages = await chain.client.multicall({
    contracts: candidates.map((p) => ({
      address: vault,
      abi: keelsonBondVaultAbi,
      functionName: "coverages" as const,
      args: [(p.countersign as unknown as CountersignJson).requestId as Hex] as const,
    })),
  });
  let recorded = 0;
  for (const [i, p] of candidates.entries()) {
    const coverage = coverages[i];
    if (coverage?.status !== "success") continue;
    const countersign = p.countersign as unknown as CountersignJson;
    const skip = () =>
      db.update(purchases).set({ validationSkippedAt: new Date() }).where(eq(purchases.id, p.id));
    if (coverage.result.status === 0) {
      // A countersign past its expiry can no longer be locked, so its purchase is never covered.
      if (Number(countersign.expiresAt) < Date.now() / 1000) await skip();
      continue;
    }
    const digest = p.digest as Buffer;
    const sigs = await countersigs(db, p.id, digest);
    if (sigs.length !== (p.mode === "degraded" ? 1 : 2)) {
      log.error(
        { purchaseId: p.id, signatures: sigs.length },
        "validation: countersignatures missing",
      );
      await skip();
      continue;
    }
    let record: TxRecord | undefined;
    try {
      record = await relayer.submit({
        chainId: CHAIN_ID,
        contract: "KeelsonValidationRegistry",
        functionName: "recordCountersign",
        args: [countersignMessage(countersign), concat(sigs), "0x"],
        key: `KeelsonValidationRegistry.recordCountersign:${toHex(digest)}`,
      });
    } catch (err) {
      if (!isDone(err, "ValidationExists")) {
        if (isDone(err, "NotCovered") || isDone(err, "InvalidCountersign")) await skip();
        log.warn({ purchaseId: p.id, err: brief(err) }, "validation not recorded");
        continue;
      }
      record = await relayer.get(
        CHAIN_ID,
        `KeelsonValidationRegistry.recordCountersign:${toHex(digest)}`,
      );
    }
    if (!record || (record.status !== "confirmed" && record.status !== "rejected")) continue;
    await db.update(purchases).set({ validationTxId: record.id }).where(eq(purchases.id, p.id));
    recorded++;
    const [lock] = await db
      .select({ confirmedAt: chainTxs.confirmedAt })
      .from(chainTxs)
      .where(
        and(
          eq(chainTxs.chainId, CHAIN_ID),
          eq(chainTxs.key, `KeelsonBondVault.lockCoverage:${countersign.requestId}`),
        ),
      );
    log.info(
      {
        purchaseId: p.id,
        txId: record.id,
        ...(lock?.confirmedAt && record.confirmedAt
          ? { lagMs: record.confirmedAt.getTime() - lock.confirmedAt.getTime() }
          : {}),
      },
      "validation recorded",
    );
  }
  return recorded;
}

/**
 * Rates the operator and records the validation's outcome of every coverage the vault released or
 * slashed, from the stored `CoverageReleased` and `Slashed` events not handled yet. An event is
 * handled once both calls are confirmed or refused for good.
 */
export async function recordOutcomes(deps: SweeperDeps): Promise<number> {
  const { db, relayer, log } = deps;
  const rows = await db
    .select({
      txHash: chainEvents.txHash,
      logIndex: chainEvents.logIndex,
      coverageId: sql<Hex>`${chainEvents.args}->>'coverageId'`,
    })
    .from(chainEvents)
    .where(
      and(
        eq(chainEvents.chainId, CHAIN_ID),
        inArray(chainEvents.name, ["CoverageReleased", "Slashed"]),
        isNull(chainEvents.handledAt),
        sql`${chainEvents.createdAt} > now() - ${OUTCOME_WINDOW}::interval`,
      ),
    )
    .orderBy(chainEvents.blockNumber)
    .limit(100);
  let sent = 0;
  for (const row of rows) {
    const coverageId = row.coverageId;
    let settled = true;
    for (const [contract, functionName, done] of [
      ["KeelsonReputationReporter", "rateCoverage", "AlreadyRated"],
      ["KeelsonValidationRegistry", "recordOutcome", "OutcomeRecorded"],
    ] as const) {
      const key = `${contract}.${functionName}:${coverageId}`;
      const existing = await relayer.get(CHAIN_ID, key);
      if (existing?.status === "confirmed" || FINAL.has(existing?.error?.name ?? "")) continue;
      try {
        const record = await relayer.submit({
          chainId: CHAIN_ID,
          contract,
          functionName,
          args: [coverageId],
          key,
        });
        if (record.status === "confirmed") {
          sent++;
          log.info({ coverageId, functionName, txId: record.id }, "coverage outcome recorded");
        } else settled = false;
      } catch (err) {
        const name = (err as RelayerError).detail as { error?: { name?: string } } | undefined;
        if (isDone(err, done) || FINAL.has(name?.error?.name ?? "")) {
          log.debug({ coverageId, functionName }, "coverage outcome already recorded");
          continue;
        }
        // A slash still pending, or a node a block behind the event: tried again on a later pass.
        settled = false;
        log.warn({ coverageId, functionName, err: brief(err) }, "coverage outcome not recorded");
      }
    }
    // Until both calls are done for good, the event is read again on each pass.
    if (settled) {
      await db
        .update(chainEvents)
        .set({ handledAt: new Date() })
        .where(
          and(
            eq(chainEvents.chainId, CHAIN_ID),
            eq(chainEvents.txHash, row.txHash),
            eq(chainEvents.logIndex, row.logIndex),
          ),
        );
    }
  }
  return sent;
}

/**
 * Records the ERC-8004 validation of every DENY purchase of an operator whose key Keelson holds,
 * with that operator's signature over the `ValidationRequest`.
 *
 * @internal
 */
export async function recordDenials(deps: SweeperDeps): Promise<number> {
  const { db, relayer, log, operators } = deps;
  if (!operators) return 0;
  const registry = addresses[CHAIN_ID].KeelsonValidationRegistry as Hex;
  const candidates = await db
    .select({
      id: purchases.id,
      countersign: purchases.countersign,
      digest: purchases.countersignDigest,
      mode: purchases.countersignMode,
    })
    .from(purchases)
    .where(
      and(
        eq(purchases.decision, DENY),
        isNull(purchases.validationTxId),
        isNull(purchases.validationSkippedAt),
        sql`${purchases.countersign} is not null`,
        sql`${purchases.createdAt} > now() - ${COVERABLE_FOR}::interval`,
      ),
    )
    .orderBy(desc(purchases.createdAt))
    .limit(100);
  let recorded = 0;
  for (const p of candidates) {
    const countersign = p.countersign as unknown as CountersignJson;
    const operator = operators(BigInt(countersign.agentId));
    const skip = () =>
      db.update(purchases).set({ validationSkippedAt: new Date() }).where(eq(purchases.id, p.id));
    if (!operator) {
      await skip();
      continue;
    }
    const digest = p.digest as Buffer;
    const sigs = await countersigs(db, p.id, digest);
    if (sigs.length !== (p.mode === "degraded" ? 1 : 2)) {
      await skip();
      continue;
    }
    const key = `KeelsonValidationRegistry.recordCountersign:${toHex(digest)}`;
    let record: TxRecord | undefined = await relayer.get(CHAIN_ID, key);
    try {
      if (!record || record.status === "rejected" || record.status === "dropped") {
        const operatorSig = await operator.signTypedData({
          domain: keelsonDomain(CHAIN_ID, registry),
          types: { ValidationRequest: [{ name: "requestHash", type: "bytes32" }] },
          primaryType: "ValidationRequest",
          message: { requestHash: toHex(digest) },
        });
        record = await relayer.submit({
          chainId: CHAIN_ID,
          contract: "KeelsonValidationRegistry",
          functionName: "recordCountersign",
          args: [countersignMessage(countersign), concat(sigs), operatorSig],
          key,
        });
      }
    } catch (err) {
      if (isDone(err, "ValidationExists")) record = await relayer.get(CHAIN_ID, key);
      else {
        if (isDone(err, "NotAgentAuthority") || isDone(err, "InvalidCountersign")) await skip();
        log.warn({ purchaseId: p.id, err: brief(err) }, "deny validation not recorded");
        continue;
      }
    }
    if (record?.status !== "confirmed") continue;
    await db.update(purchases).set({ validationTxId: record.id }).where(eq(purchases.id, p.id));
    recorded++;
    log.info({ purchaseId: p.id, txId: record.id }, "deny validation recorded");
  }
  return recorded;
}

/**
 * The coverages whose window has passed, from the stored `CoverageLocked` events: not released,
 * with no slash queued and neither executed nor vetoed. The vault's clock may trail this one by
 * a block, so a coverage is due `RELEASE_MARGIN_S` after its `releaseAfter`.
 *
 * @internal
 */
export async function dueCoverages(db: Db): Promise<Hex[]> {
  const rows = await db.execute<{ coverage_id: Hex }>(sql`
    select l.args->>'coverageId' as coverage_id
    from chain_events l
    where l.chain_id = ${CHAIN_ID} and l.name = 'CoverageLocked'
      and (l.args->>'releaseAfter')::bigint + ${RELEASE_MARGIN_S} < extract(epoch from now())
      and (l.args->>'releaseAfter')::bigint > extract(epoch from now() - ${RELEASABLE_FOR}::interval)
      and not exists (
        select 1 from chain_events r
        where r.chain_id = l.chain_id and r.name = 'CoverageReleased'
          and r.args->>'coverageId' = l.args->>'coverageId')
      and not exists (
        select 1 from chain_txs t
        where t.chain_id = l.chain_id and t.status = 'confirmed'
          and t.key = 'KeelsonBondVault.releaseCoverage:' || (l.args->>'coverageId'))
      and not exists (
        select 1 from chain_events q
        where q.chain_id = l.chain_id and q.name = 'SlashQueued'
          and q.args->>'coverageId' = l.args->>'coverageId'
          and not exists (
            select 1 from chain_events e
            where e.chain_id = q.chain_id and e.name in ('Slashed', 'SlashVetoed')
              and e.args->>'disputeId' = q.args->>'disputeId'))
    order by (l.args->>'releaseAfter')::bigint
    limit 100`);
  return rows.rows.map((r) => r.coverage_id);
}

/**
 * Releases every coverage whose window has passed, so the operator's bond is free again: the
 * stored events say which are due, and the chain is only asked to release those. Anyone may call
 * `releaseCoverage`; the relayer pays for it.
 *
 * @internal
 */
export async function releaseCoverages(deps: SweeperDeps): Promise<number> {
  const { db, relayer, log } = deps;
  let released = 0;
  for (const coverageId of await dueCoverages(db)) {
    try {
      const record = await relayer.submit({
        chainId: CHAIN_ID,
        contract: "KeelsonBondVault",
        functionName: "releaseCoverage",
        args: [coverageId],
        key: `KeelsonBondVault.releaseCoverage:${coverageId}`,
      });
      if (record.status === "confirmed") {
        released++;
        log.info({ coverageId, txId: record.id }, "coverage released");
      }
    } catch (err) {
      log.warn({ coverageId, err: brief(err) }, "coverage not released");
    }
  }
  return released;
}

export function startValidationSweeper(deps: SweeperDeps): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void Promise.all([
      recordValidations(deps).catch((err: unknown) =>
        deps.log.error({ err: brief(err) }, "validation sweep failed"),
      ),
      recordDenials(deps).catch((err: unknown) =>
        deps.log.error({ err: brief(err) }, "deny validation sweep failed"),
      ),
      releaseCoverages(deps).catch((err: unknown) =>
        deps.log.error({ err: brief(err) }, "coverage release sweep failed"),
      ),
    ]).finally(() => {
      running = false;
    });
  }, SWEEP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
