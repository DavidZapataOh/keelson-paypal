import { addresses, checkpointAnchorAbi } from "@keelson/chain";
import { fromHex, toHex } from "@keelson/core";
import { alibis, and, asc, type Db, eq, isNull, lt, or, purchases, sql } from "@keelson/db";
import {
  LOG_HOST,
  LOG_ORIGINS,
  LOG_VKEYS,
  verifyConsistency,
  verifyProof,
  verifyWitnessedCheckpoint,
} from "@keelson/log";
import type { Logger } from "pino";
import type { RedisClientType } from "redis";
import {
  type Address,
  decodeFunctionData,
  type Hex,
  hexToString,
  isAddressEqual,
  keccak256,
  type PublicClient,
  parseEventLogs,
  stringToBytes,
} from "viem";
import type { LogConfig } from "../log/append.ts";

/** The block `CheckpointAnchor` was deployed at, where the search for its events starts. */
const DEPLOYED_AT: Readonly<Record<number, bigint>> = { 421614: 327_211_576n };
const INTERVAL_MS = 30_000;
const BATCH = 50;
/** The block range of one `eth_getLogs` call. */
const LOG_RANGE = 100_000n;
/** About 5 s of Arbitrum blocks, so a block the RPC has not indexed yet is scanned on a later pass. */
const CONFIRMATIONS = 20n;

export interface AnchorDeps {
  db: Db;
  kv: RedisClientType;
  log: Logger;
  /** `logs` serves `eth_getLogs` over wide ranges. */
  chain: { client: PublicClient; logs?: PublicClient };
  tlog: LogConfig;
}

interface Anchored {
  txHash: Hex;
  blockNumber: string;
  root: Hex;
}

const cursorKey = (chainId: number) => `alibi:anchors:${chainId}`;
const eventsKey = (chainId: number) => `alibi:anchors:${chainId}:events`;

/** The `CheckpointAnchored` event of `size` for `origin`, scanning new blocks once. */
async function anchoredAt(
  deps: AnchorDeps,
  chainId: number,
  originHash: Hex,
  size: bigint,
): Promise<Anchored | undefined> {
  const field = `${originHash}:${size}`;
  const known = await deps.kv.hGet(eventsKey(chainId), field);
  if (known) return JSON.parse(known) as Anchored;
  const contract = addresses[chainId as 421614].CheckpointAnchor as Address;
  const cursor = await deps.kv.get(cursorKey(chainId));
  const fromBlock = cursor ? BigInt(cursor) + 1n : (DEPLOYED_AT[chainId] ?? 0n);
  // Head and logs from the same RPC, kept CONFIRMATIONS behind its head: a block that RPC has not
  // indexed yet is never passed by the cursor.
  const logClient = deps.chain.logs ?? deps.chain.client;
  const latest = (await logClient.getBlockNumber()) - CONFIRMATIONS;
  for (let from = fromBlock; from <= latest; from += LOG_RANGE) {
    // biome-ignore lint/complexity/useMathMinMax: block numbers are bigints.
    const to = from + LOG_RANGE - 1n < latest ? from + LOG_RANGE - 1n : latest;
    const logs = await logClient.getContractEvents({
      address: contract,
      abi: checkpointAnchorAbi,
      eventName: "CheckpointAnchored",
      fromBlock: from,
      toBlock: to,
    });
    for (const l of logs) {
      const { origin, size: s, root } = l.args as { origin: Hex; size: bigint; root: Hex };
      const value: Anchored = {
        txHash: l.transactionHash,
        blockNumber: String(l.blockNumber),
        root,
      };
      await deps.kv.hSet(eventsKey(chainId), `${origin}:${s}`, JSON.stringify(value));
    }
    await deps.kv.set(cursorKey(chainId), String(to));
  }
  const found = await deps.kv.hGet(eventsKey(chainId), field);
  return found ? (JSON.parse(found) as Anchored) : undefined;
}

/**
 * Records the `CheckpointAnchored` events of an anchor transaction from its receipt, for an anchor
 * this process asked for: the scan of the chain's logs stays `CONFIRMATIONS` blocks behind its
 * head, seconds after the receipt. `reanchorAlibi` still checks the transaction's checkpoint.
 */
export async function recordAnchor(
  deps: Pick<AnchorDeps, "kv"> & { chain: { client: PublicClient } },
  chainId: number,
  txHash: Hex,
): Promise<void> {
  const receipt = await deps.chain.client.waitForTransactionReceipt({ hash: txHash });
  const contract = addresses[chainId as 421614].CheckpointAnchor as Address;
  const events = parseEventLogs({
    abi: checkpointAnchorAbi,
    eventName: "CheckpointAnchored",
    logs: receipt.logs.filter((l) => isAddressEqual(l.address, contract)),
  });
  for (const e of events) {
    const value: Anchored = {
      txHash: e.transactionHash,
      blockNumber: String(e.blockNumber),
      root: e.args.root,
    };
    await deps.kv.hSet(
      eventsKey(chainId),
      `${e.args.origin}:${e.args.size}`,
      JSON.stringify(value),
    );
  }
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

  const [size, root] = await deps.chain.client.readContract({
    address: contract,
    abi: checkpointAnchorAbi,
    functionName: "latest",
    args: [originHash],
  });
  const { tlog_proof: tlogProof } = row.bundle as { tlog_proof: string };
  const { index, checkpoint } = verifyProof(
    tlogProof,
    new Uint8Array(row.leafHash),
    LOG_VKEYS[origin] ?? [],
  );
  if (index >= size) return "not_covered";

  const event = await anchoredAt(deps, chainId, originHash, size);
  if (!event) return "not_covered";
  const tx = await deps.chain.client.getTransaction({ hash: event.txHash });
  const { functionName, args } = decodeFunctionData({ abi: checkpointAnchorAbi, data: tx.input });
  if (functionName !== "anchor") throw new Error(`${event.txHash} is not an anchor call`);
  const signed = hexToString(args[5] as Hex);
  const anchored = verifyWitnessedCheckpoint(signed);
  if (anchored.origin !== origin || anchored.size !== size || toHex(anchored.root) !== root) {
    throw new Error(`the note of ${event.txHash} is not the anchored checkpoint`);
  }
  if (event.root !== root) throw new Error(`the event of ${event.txHash} is not the latest root`);
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
 * One pass: anchors every Alibi the latest anchored checkpoint of its chain covers.
 *
 * @internal
 */
export async function anchorCovered(deps: AnchorDeps): Promise<number> {
  const chainId = 421614;
  const origin = LOG_ORIGINS[chainId] as string;
  const [size] = await deps.chain.client.readContract({
    address: addresses[chainId].CheckpointAnchor as Address,
    abi: checkpointAnchorAbi,
    functionName: "latest",
    args: [keccak256(stringToBytes(origin))],
  });
  const rows = await deps.db
    .select({ id: alibis.purchaseId })
    .from(alibis)
    .innerJoin(purchases, eq(purchases.id, alibis.purchaseId))
    .where(
      and(
        isNull(alibis.anchor),
        lt(purchases.logIndex, size),
        or(isNull(purchases.chainId), eq(purchases.chainId, chainId)),
      ),
    )
    .orderBy(asc(purchases.logIndex))
    .limit(BATCH);
  let anchored = 0;
  for (const r of rows) {
    try {
      if ((await reanchorAlibi(deps, r.id)) === "anchored") anchored++;
    } catch (err) {
      deps.log.warn({ err, purchaseId: r.id }, "alibi not re-anchored");
    }
  }
  return anchored;
}

/** Every 30 s, on one process of the deployment at a time, anchors the covered Alibis. */
export function startAnchorWatcher(
  deps: AnchorDeps,
  { intervalMs = INTERVAL_MS }: { intervalMs?: number } = {},
): { stop(): Promise<void> } {
  let running: Promise<void> | undefined;
  const tick = async () => {
    const lock = await deps.kv.set("alibi:anchors:lock", "1", { NX: true, PX: intervalMs - 1000 });
    if (lock !== "OK") return;
    const n = await anchorCovered(deps);
    if (n > 0) deps.log.info({ anchored: n }, "alibis anchored");
  };
  const timer = setInterval(() => {
    if (running) return;
    running = tick()
      .catch((err: unknown) => deps.log.warn({ err }, "alibi anchoring failed"))
      .finally(() => {
        running = undefined;
      });
  }, intervalMs);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}
