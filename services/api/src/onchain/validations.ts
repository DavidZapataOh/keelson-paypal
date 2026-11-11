import { addresses, keelsonBondVaultAbi } from "@keelson/chain";
import { keelsonDomain } from "@keelson/core/eip712";
import {
  and,
  asc,
  chainTxs,
  type Db,
  desc,
  eq,
  isNull,
  like,
  purchases,
  sql,
  teeSignatures,
  teeSigners,
} from "@keelson/db";
import { type Relayer, RelayerError, type TxRecord } from "@keelson/relayer";
import type { Logger } from "pino";
import type { RedisClientType } from "redis";
import { BaseError, concat, type Hex, type PublicClient, toHex } from "viem";
import { ERC8004_DEPLOY_BLOCK } from "../chain/reader.ts";
import type { OperatorSigners } from "../operators/signer.ts";
import type { CountersignJson } from "../tee/client.ts";
import { countersignMessage } from "../tee/coordinator.ts";

const SWEEP_INTERVAL_MS = 10_000;
const CHAIN_ID = 421614;
/** A countersign expires within minutes; one never covered by then never will be. */
const COVERABLE_FOR = "1 day";
/** Vault events are re-read this far back on every pass, so a restart misses none. */
const OUTCOME_LOOKBACK_BLOCKS = 20_000n;
const CURSOR_KEY = `relayer:outcomes:${CHAIN_ID}`;
const ALLOW = 1;
const DENY = 2;
const ACTIVE = 1;
/** Coverages are looked for among locks confirmed this recently: past a degraded lock's 72 h window. */
const RELEASABLE_FOR = "4 days";
/** Reverts that no later state changes: the outcome is recorded, or there is no validation to update. */
const FINAL = new Set(["AlreadyRated", "OutcomeRecorded", "UnknownValidation"]);

export interface SweeperDeps {
  db: Db;
  kv: RedisClientType;
  log: Logger;
  relayer: Relayer;
  /** Reads the vault; `logs` scans its events over wide ranges. */
  chain: { client: PublicClient; logs: PublicClient };
  /** Signs the `ValidationRequest` of an operator's DENY purchases; DENY validations wait without it. */
  operators?: OperatorSigners | undefined;
  /** No outcome before this block is looked for; the reporter and the registry did not exist yet. */
  outcomesFrom?: bigint;
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
 * Rates the operator and records the validation's outcome of every coverage the vault released or slashed.
 *
 * @internal
 */
export async function recordOutcomes(deps: SweeperDeps): Promise<number> {
  const { kv, relayer, chain, log } = deps;
  const vault = addresses[CHAIN_ID].KeelsonBondVault as Hex;
  const latest = await chain.logs.getBlockNumber();
  let fromBlock = BigInt((await kv.get(CURSOR_KEY)) ?? latest);
  if (fromBlock > latest) fromBlock = latest;
  fromBlock -= OUTCOME_LOOKBACK_BLOCKS;
  const floor = deps.outcomesFrom ?? ERC8004_DEPLOY_BLOCK[CHAIN_ID];
  if (fromBlock < floor) fromBlock = floor;
  const [released, slashed] = await Promise.all([
    chain.logs.getContractEvents({
      address: vault,
      abi: keelsonBondVaultAbi,
      eventName: "CoverageReleased",
      fromBlock,
      toBlock: latest,
    }),
    chain.logs.getContractEvents({
      address: vault,
      abi: keelsonBondVaultAbi,
      eventName: "Slashed",
      fromBlock,
      toBlock: latest,
    }),
  ]);
  const ended = new Set([...released, ...slashed].map((e) => e.args.coverageId as Hex));
  let sent = 0;
  let failed = false;
  for (const coverageId of ended) {
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
        }
      } catch (err) {
        // Already done by someone else, no validation to update, or a slash still pending: nothing to send now.
        if (!(err instanceof RelayerError) || err.code !== "simulation-reverted") {
          failed = true;
          log.warn({ coverageId, functionName, err: brief(err) }, "coverage outcome not recorded");
        } else if (isDone(err, done)) {
          log.debug({ coverageId, functionName }, "coverage outcome already recorded");
        }
      }
    }
  }
  // After a failure the same range is read again, however long the outage.
  if (!failed) await kv.set(CURSOR_KEY, latest.toString());
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

const LOCK_KEY = "KeelsonBondVault.lockCoverage:";
const RELEASE_KEY = "KeelsonBondVault.releaseCoverage:";
/** Coverages read from the vault on one pass. */
const RELEASE_BATCH = 500;

/**
 * The coverage ids of recent locks Keelson has not released yet, oldest first, so released ones
 * never crowd out those still active.
 *
 * @internal
 */
export async function releasableLocks(db: Db, limit: number): Promise<Hex[]> {
  const locks = await db
    .select({ key: chainTxs.key })
    .from(chainTxs)
    .where(
      and(
        eq(chainTxs.chainId, CHAIN_ID),
        eq(chainTxs.status, "confirmed"),
        like(chainTxs.key, `${LOCK_KEY}%`),
        sql`${chainTxs.confirmedAt} > now() - ${RELEASABLE_FOR}::interval`,
        sql`not exists (select 1 from ${chainTxs} r where r.chain_id = ${chainTxs.chainId} and r.status = 'confirmed' and r.key = ${RELEASE_KEY} || substr(${chainTxs.key}, ${LOCK_KEY.length + 1}))`,
      ),
    )
    .orderBy(asc(chainTxs.confirmedAt))
    .limit(limit);
  return locks.map((l) => l.key.slice(LOCK_KEY.length) as Hex);
}

/**
 * Releases every coverage Keelson locked whose window has passed, so the operator's bond is free
 * again. Anyone may call `releaseCoverage`; the relayer pays for it.
 *
 * @internal
 */
export async function releaseCoverages(deps: SweeperDeps): Promise<number> {
  const { db, relayer, chain, log } = deps;
  const vault = addresses[CHAIN_ID].KeelsonBondVault as Hex;
  const ids = await releasableLocks(db, RELEASE_BATCH);
  if (ids.length === 0) return 0;
  const [block, coverages] = await Promise.all([
    chain.client.getBlock({ blockTag: "latest" }),
    chain.client.multicall({
      contracts: ids.map((id) => ({
        address: vault,
        abi: keelsonBondVaultAbi,
        functionName: "coverages" as const,
        args: [id] as const,
      })),
    }),
  ]);
  let released = 0;
  for (const [i, coverageId] of ids.entries()) {
    const c = coverages[i];
    if (c?.status !== "success" || c.result.status !== ACTIVE) continue;
    if (c.result.pendingSlashes !== 0 || BigInt(c.result.releaseAfter) >= block.timestamp) continue;
    try {
      const record = await relayer.submit({
        chainId: CHAIN_ID,
        contract: "KeelsonBondVault",
        functionName: "releaseCoverage",
        args: [coverageId],
        key: `${RELEASE_KEY}${coverageId}`,
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
      recordOutcomes(deps).catch((err: unknown) =>
        deps.log.error({ err: brief(err) }, "outcome sweep failed"),
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
