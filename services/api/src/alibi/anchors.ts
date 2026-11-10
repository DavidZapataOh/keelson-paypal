import { addresses, checkpointAnchorAbi } from "@keelson/chain";
import { fromHex, toHex } from "@keelson/core";
import {
  alibis,
  and,
  asc,
  chainEvents,
  type Db,
  desc,
  eq,
  isNull,
  lt,
  or,
  purchases,
  sql,
} from "@keelson/db";
import {
  LOG_HOST,
  LOG_ORIGINS,
  LOG_VKEYS,
  verifyConsistency,
  verifyProof,
  verifyWitnessedCheckpoint,
} from "@keelson/log";
import type { Logger } from "pino";
import {
  type Address,
  decodeFunctionData,
  type Hex,
  hexToString,
  keccak256,
  type PublicClient,
  stringToBytes,
} from "viem";
import { ingestReceipt } from "../chain/events.ts";
import type { LogConfig } from "../log/append.ts";

const BATCH = 50;

export interface AnchorDeps {
  db: Db;
  log: Logger;
  chain: { client: PublicClient };
  tlog: LogConfig;
}

interface Anchored {
  size: bigint;
  /** When the event was stored: within a second or so of its block, live. */
  seenAt: Date;
  root: Hex;
  txHash: Hex;
  blockNumber: string;
}

const anchoredRow = {
  size: sql<string>`${chainEvents.args}->>'size'`,
  root: sql<Hex>`${chainEvents.args}->>'root'`,
  txHash: chainEvents.txHash,
  blockNumber: chainEvents.blockNumber,
  seenAt: chainEvents.createdAt,
};
const toAnchored = (r: {
  size: string;
  root: Hex;
  txHash: Buffer;
  blockNumber: bigint;
  seenAt: Date;
}) => ({
  size: BigInt(r.size),
  seenAt: r.seenAt,
  root: r.root,
  txHash: toHex(r.txHash) as Hex,
  blockNumber: String(r.blockNumber),
});

/** The latest stored `CheckpointAnchored` event of `origin`. */
export async function latestAnchor(
  db: Db,
  chainId: number,
  originHash: Hex,
): Promise<Anchored | undefined> {
  const [row] = await db
    .select(anchoredRow)
    .from(chainEvents)
    .where(
      and(
        eq(chainEvents.chainId, chainId),
        eq(chainEvents.name, "CheckpointAnchored"),
        sql`${chainEvents.args}->>'origin' = ${originHash.toLowerCase()}`,
      ),
    )
    .orderBy(desc(sql`(${chainEvents.args}->>'size')::numeric`))
    .limit(1);
  return row ? toAnchored(row) : undefined;
}

/**
 * Stores the `CheckpointAnchored` events of an anchor transaction from its receipt, for an anchor
 * this process asked for, ahead of the subscription. `reanchorAlibi` still checks the
 * transaction's checkpoint.
 */
export async function recordAnchor(
  deps: Pick<AnchorDeps, "db"> & { chain: { client: PublicClient } },
  _chainId: number,
  txHash: Hex,
): Promise<void> {
  const receipt = await deps.chain.client.waitForTransactionReceipt({ hash: txHash });
  await ingestReceipt(deps.db, receipt);
}

/** A consistency proof from the log's private listener, as hex nodes. */
async function consistency(tlog: LogConfig, origin: string, from: bigint, to: bigint) {
  if (from === to) return [];
  const path = origin.slice(LOG_HOST.length + 1);
  const res = await fetch(
    `${tlog.url.replace(/\/$/, "")}/${path}/consistency?from=${from}&to=${to}`,
    {
      headers: { authorization: `Bearer ${tlog.token}` },
      signal: AbortSignal.timeout(tlog.timeoutMs ?? 8000),
    },
  );
  if (!res.ok) throw new Error(`consistency ${from}..${to}: ${res.status}`);
  const body = (await res.json()) as { proof: string[] };
  return body.proof.map((p) => toHex(Uint8Array.from(Buffer.from(p, "base64"))));
}

/**
 * Re-issues a purchase's Alibi with the anchor of the latest anchored checkpoint, once that
 * checkpoint covers its leaf: the anchor's checkpoint must carry the pinned log signatures and
 * witness quorum, match the event, and be consistent with the Alibi's proof checkpoint. Every
 * earlier section stays as it was.
 */
export async function reanchorAlibi(
  deps: AnchorDeps,
  purchaseId: string,
): Promise<"anchored" | "not_covered" | "already"> {
  const [row] = await deps.db
    .select({
      bundle: alibis.bundle,
      anchor: alibis.anchor,
      leafHash: alibis.leafHash,
      chainId: purchases.chainId,
    })
    .from(alibis)
    .innerJoin(purchases, eq(purchases.id, alibis.purchaseId))
    .where(eq(alibis.purchaseId, purchaseId));
  if (!row) throw new Error(`purchase ${purchaseId} has no alibi`);
  if (row.anchor) return "already";
  const chainId = row.chainId ?? 421614;
  const origin = LOG_ORIGINS[chainId];
  const contract = addresses[chainId as 421614]?.CheckpointAnchor as Address | undefined;
  if (!origin || !contract) throw new Error(`chain ${chainId} has no anchor`);
  const originHash = keccak256(stringToBytes(origin));

  const event = await latestAnchor(deps.db, chainId, originHash);
  if (!event) return "not_covered";
  const { size, root } = event;
  const { tlog_proof: tlogProof } = row.bundle as { tlog_proof: string };
  const { index, checkpoint } = verifyProof(
    tlogProof,
    new Uint8Array(row.leafHash),
    LOG_VKEYS[origin] ?? [],
  );
  if (index >= size) return "not_covered";

  const tx = await deps.chain.client.getTransaction({ hash: event.txHash });
  const { functionName, args } = decodeFunctionData({ abi: checkpointAnchorAbi, data: tx.input });
  if (functionName !== "anchor") throw new Error(`${event.txHash} is not an anchor call`);
  const signed = hexToString(args[5] as Hex);
  const anchored = verifyWitnessedCheckpoint(signed);
  if (anchored.origin !== origin || anchored.size !== size || toHex(anchored.root) !== root) {
    throw new Error(`the note of ${event.txHash} is not the anchored checkpoint`);
  }
  const older = anchored.size <= checkpoint.size;
  const [from, to] = older ? [anchored, checkpoint] : [checkpoint, anchored];
  const proof = await consistency(deps.tlog, origin, from.size, to.size);
  if (!verifyConsistency(from.size, to.size, from.root, to.root, proof.map(fromHex))) {
    throw new Error(`the log's consistency proof ${from.size}..${to.size} does not verify`);
  }

  const section = {
    chain_id: chainId,
    contract,
    tx_hash: event.txHash.toLowerCase(),
    block_number: event.blockNumber,
    anchored_size: String(size),
    anchored_root: root.toLowerCase(),
    checkpoint: signed,
    consistency: { from: String(from.size), to: String(to.size), proof },
  };
  const updated = await deps.db.transaction(async (tx) => {
    const set = await tx
      .update(alibis)
      .set({ anchor: section })
      .where(and(eq(alibis.purchaseId, purchaseId), isNull(alibis.anchor)))
      .returning({ id: alibis.purchaseId });
    if (set.length === 0) return false;
    await tx
      .update(purchases)
      .set({ anchoredSize: size, chainId, updatedAt: sql`now()` })
      .where(eq(purchases.id, purchaseId));
    return true;
  });
  return updated ? "anchored" : "already";
}

/**
 * Anchors every Alibi the latest stored anchor of its chain covers, then marks the stored
 * `CheckpointAnchored` events handled. Runs on each new anchor event and each reconcile.
 *
 * @internal
 */
export async function anchorCovered(deps: AnchorDeps): Promise<number> {
  const chainId = 421614;
  const origin = LOG_ORIGINS[chainId] as string;
  const latest = await latestAnchor(deps.db, chainId, keccak256(stringToBytes(origin)));
  if (!latest) return 0;
  const rows = await deps.db
    .select({ id: alibis.purchaseId })
    .from(alibis)
    .innerJoin(purchases, eq(purchases.id, alibis.purchaseId))
    .where(
      and(
        isNull(alibis.anchor),
        lt(purchases.logIndex, latest.size),
        or(isNull(purchases.chainId), eq(purchases.chainId, chainId)),
      ),
    )
    .orderBy(asc(purchases.logIndex))
    .limit(BATCH);
  let anchored = 0;
  let failed = false;
  for (const r of rows) {
    try {
      if ((await reanchorAlibi(deps, r.id)) === "anchored") anchored++;
    } catch (err) {
      failed = true;
      deps.log.warn({ err, purchaseId: r.id }, "alibi not re-anchored");
    }
  }
  if (!failed && rows.length < BATCH) {
    await deps.db
      .update(chainEvents)
      .set({ handledAt: new Date() })
      .where(
        and(
          eq(chainEvents.chainId, chainId),
          eq(chainEvents.name, "CheckpointAnchored"),
          isNull(chainEvents.handledAt),
        ),
      );
  }
  if (anchored > 0) deps.log.info({ anchored }, "alibis anchored");
  return anchored;
}
