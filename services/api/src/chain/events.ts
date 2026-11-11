import {
  addresses,
  amberContradictionCourtAbi,
  checkpointAnchorAbi,
  keelsonBondVaultAbi,
} from "@keelson/chain";
import { and, chainCursors, chainEvents, type Db, eq, sql } from "@keelson/db";
import type { Logger } from "pino";
import type { RedisClientType } from "redis";
import {
  type AbiEvent,
  type Address,
  BaseError,
  bytesToHex,
  createPublicClient,
  type Hex,
  hexToBytes,
  isAddressEqual,
  type Log,
  type PublicClient,
  parseEventLogs,
  type TransactionReceipt,
  webSocket,
} from "viem";
import { arbitrumSepolia } from "viem/chains";

export const CHAIN_ID = arbitrumSepolia.id;

const VAULT_EVENTS = [
  "CoverageLocked",
  "CoverageReleased",
  "Slashed",
  "SlashQueued",
  "SlashVetoed",
] as const;

/** The events Keelson acts on: one `eth_getLogs` or subscription asks for all of them. */
const EVENTS: readonly AbiEvent[] = [
  ...keelsonBondVaultAbi.filter(
    (i): i is Extract<(typeof keelsonBondVaultAbi)[number], { type: "event" }> =>
      i.type === "event" && (VAULT_EVENTS as readonly string[]).includes(i.name),
  ),
  ...checkpointAnchorAbi.filter(
    (i): i is Extract<(typeof checkpointAnchorAbi)[number], { type: "event" }> =>
      i.type === "event" && i.name === "CheckpointAnchored",
  ),
  ...amberContradictionCourtAbi.filter(
    (i): i is Extract<(typeof amberContradictionCourtAbi)[number], { type: "event" }> =>
      i.type === "event" && i.name === "AmberContradictionProven",
  ),
];

/**
 * The vault and the anchor whose events are followed.
 *
 * @internal
 */
export const CONTRACTS: readonly Address[] = [
  addresses[CHAIN_ID].KeelsonBondVault as Address,
  addresses[CHAIN_ID].CheckpointAnchor as Address,
  addresses[CHAIN_ID].AmberContradictionCourt as Address,
];

/** A decoded log of one of `EVENTS`. */
export type EventLog = Log<bigint, number, false> & {
  eventName: string;
  args: Record<string, unknown>;
};

const buf = (h: Hex) => Buffer.from(hexToBytes(h));
const plain = (args: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(args).map(([k, v]) => [
      k,
      typeof v === "bigint" ? v.toString() : (v as string | boolean),
    ]),
  );

/**
 * Stores `logs`, once each by `(chainId, txHash, logIndex)`. A log seen again takes its latest
 * block, and stays final once marked so. Returns the logs stored for the first time.
 *
 * @internal
 */
export async function ingest(
  db: Pick<Db, "insert">,
  logs: readonly EventLog[],
  { finalized }: { finalized: boolean },
): Promise<EventLog[]> {
  const byKey = new Map(
    logs
      .filter((l) => !l.removed && l.transactionHash && l.blockHash)
      .map((l) => [`${(l.transactionHash as Hex).toLowerCase()}:${l.logIndex}`, l]),
  );
  const rows = [...byKey.values()];
  if (rows.length === 0) return [];
  const stored = await db
    .insert(chainEvents)
    .values(
      rows.map((l) => ({
        chainId: CHAIN_ID,
        txHash: buf(l.transactionHash as Hex),
        logIndex: l.logIndex as number,
        blockNumber: l.blockNumber as bigint,
        blockHash: buf(l.blockHash as Hex),
        address: buf(l.address),
        name: l.eventName,
        args: plain(l.args),
        finalized,
      })),
    )
    .onConflictDoUpdate({
      target: [chainEvents.chainId, chainEvents.txHash, chainEvents.logIndex],
      set: {
        blockNumber: sql`excluded.block_number`,
        blockHash: sql`excluded.block_hash`,
        finalized: sql`${chainEvents.finalized} or excluded.finalized`,
      },
    })
    .returning({
      txHash: chainEvents.txHash,
      logIndex: chainEvents.logIndex,
      inserted: sql<boolean>`xmax = 0`,
    });
  const fresh = new Set(
    stored.filter((s) => s.inserted).map((s) => `${bytesToHex(s.txHash)}:${s.logIndex}`),
  );
  return rows.filter((l) => fresh.has(`${(l.transactionHash as Hex).toLowerCase()}:${l.logIndex}`));
}

/** Stores the events of a receipt this process waited for, ahead of the subscription. */
export function ingestReceipt(
  db: Pick<Db, "insert">,
  receipt: Pick<TransactionReceipt, "logs">,
): Promise<EventLog[]> {
  const logs = parseEventLogs({
    abi: EVENTS,
    logs: receipt.logs.filter((l) => CONTRACTS.some((c) => isAddressEqual(c, l.address))),
  });
  return ingest(db, logs as unknown as EventLog[], { finalized: false });
}

/** Drops the logs a reorg removed, unless the reconciler already saw them final. *
 * @internal
 */
export async function retract(db: Db, logs: readonly EventLog[]): Promise<void> {
  for (const l of logs) {
    if (!l.transactionHash || l.logIndex === null) continue;
    await db
      .delete(chainEvents)
      .where(
        and(
          eq(chainEvents.chainId, CHAIN_ID),
          eq(chainEvents.txHash, buf(l.transactionHash)),
          eq(chainEvents.logIndex, l.logIndex),
          eq(chainEvents.finalized, false),
        ),
      );
  }
}

/** The last block whose events are all stored and final; undefined before the first reconcile. */
export async function finalizedBlock(db: Db): Promise<{ block: bigint; at: Date } | undefined> {
  const [row] = await db
    .select({ block: chainCursors.block, at: chainCursors.updatedAt })
    .from(chainCursors)
    .where(eq(chainCursors.chainId, CHAIN_ID));
  return row;
}

/**
 * Whether a transaction recorded at `block` is final: the reconciled `finalized` block has
 * passed it, and the receipt a node serves now, after any reorg, is a success at or below it.
 * The node is asked only once the cursor passed the recorded block.
 */
export function isFinal(db: Db, client: PublicClient) {
  return async ({ hash, block }: { hash: Hex; block: bigint }): Promise<boolean> => {
    const cursor = await finalizedBlock(db);
    if (!cursor || cursor.block < block) return false;
    const receipt = await client.getTransactionReceipt({ hash }).catch(() => undefined);
    return receipt?.status === "success" && receipt.blockNumber <= cursor.block;
  };
}

/**
 * The widest `eth_getLogs` range tried; a provider that refuses it gets halves, down to
 * `MIN_RANGE`. dRPC's free plan refuses more than 10,000 blocks.
 */
const MAX_RANGE = 10_000n;
const MIN_RANGE = 50n;
/** Where the first reconcile starts, below `finalized`: about a week of Arbitrum blocks. *
 * @internal
 */
export const BACKFILL_BLOCKS = 2_500_000n;
/** No followed event is older than the anchor's deployment, the first of the three. */
const DEPLOYED_AT = 327_211_576n;

export interface ReconcileDeps {
  db: Db;
  /** Serves `eth_getLogs` and the `finalized` block. */
  logs: PublicClient;
  log: Logger;
}

let range = MAX_RANGE;

/** Reads every log of `EVENTS` in `[from, to]`, a chunk at a time, narrowing on refusal. */
async function readLogs(
  deps: ReconcileDeps,
  from: bigint,
  to: bigint,
  onChunk: (logs: EventLog[], from: bigint, to: bigint) => Promise<void>,
): Promise<void> {
  while (from <= to) {
    const end = from + range - 1n < to ? from + range - 1n : to;
    let logs: EventLog[];
    try {
      logs = (await deps.logs.getLogs({
        address: [...CONTRACTS],
        events: EVENTS,
        fromBlock: from,
        toBlock: end,
        strict: true,
      })) as unknown as EventLog[];
    } catch (err) {
      if (range <= MIN_RANGE) throw err;
      range /= 2n;
      deps.log.debug({ range: String(range), err: brief(err) }, "chain events: narrower range");
      continue;
    }
    await onChunk(logs, from, end);
    from = end + 1n;
    if (range < MAX_RANGE) range *= 2n;
  }
}

/**
 * The stored live logs in `[from, to]` the canonical chain does not have: each is dropped when
 * its block's hash changed, a reorg. A log whose block is still canonical means the node that
 * answered missed it; the chunk is read again on the next pass.
 */
async function orphans(
  deps: ReconcileDeps,
  logs: readonly EventLog[],
  from: bigint,
  to: bigint,
): Promise<{ txHash: Buffer; logIndex: number }[]> {
  const canonical = new Set(
    logs.map((l) => `${(l.transactionHash as Hex).toLowerCase()}:${l.logIndex}`),
  );
  const live = await deps.db
    .select({
      txHash: chainEvents.txHash,
      logIndex: chainEvents.logIndex,
      blockNumber: chainEvents.blockNumber,
      blockHash: chainEvents.blockHash,
    })
    .from(chainEvents)
    .where(
      and(
        eq(chainEvents.chainId, CHAIN_ID),
        sql`${chainEvents.blockNumber} between ${from} and ${to}`,
        eq(chainEvents.finalized, false),
      ),
    );
  const missing = live.filter((r) => !canonical.has(`${bytesToHex(r.txHash)}:${r.logIndex}`));
  const hashes = new Map<bigint, Hex>();
  for (const r of missing) {
    if (!hashes.has(r.blockNumber)) {
      hashes.set(r.blockNumber, (await deps.logs.getBlock({ blockNumber: r.blockNumber })).hash);
    }
    if (hashes.get(r.blockNumber) === bytesToHex(r.blockHash)) {
      throw new Error(
        `the logs of blocks ${from}..${to} miss a log of canonical block ${r.blockNumber}`,
      );
    }
  }
  return missing;
}

const moveCursor = (db: Pick<Db, "insert">, block: bigint) =>
  db
    .insert(chainCursors)
    .values({ chainId: CHAIN_ID, block })
    .onConflictDoUpdate({
      target: chainCursors.chainId,
      // Never backwards, whichever of two overlapping passes writes last.
      set: { block: sql`greatest(${chainCursors.block}, excluded.block)`, updatedAt: sql`now()` },
    });

/**
 * Reads every log of `EVENTS` from the cursor to the chain's `finalized` block. Each chunk
 * replaces what the live subscription stored for its blocks: logs a reorg removed are deleted,
 * the rest stored final, and the cursor moves past it in the same transaction. Returns the logs
 * stored for the first time.
 *
 * @internal
 */
export async function reconcile(deps: ReconcileDeps): Promise<EventLog[]> {
  const head = await deps.logs.getBlock({ blockTag: "finalized" });
  const cursor = await finalizedBlock(deps.db);
  const from = cursor
    ? cursor.block + 1n
    : head.number - BACKFILL_BLOCKS > DEPLOYED_AT
      ? head.number - BACKFILL_BLOCKS
      : DEPLOYED_AT;
  const fresh: EventLog[] = [];
  await readLogs(deps, from, head.number, async (logs, start, end) => {
    const removed = await orphans(deps, logs, start, end);
    const stored = await deps.db.transaction(async (tx) => {
      for (const r of removed) {
        await tx
          .delete(chainEvents)
          .where(
            and(
              eq(chainEvents.chainId, CHAIN_ID),
              eq(chainEvents.txHash, r.txHash),
              eq(chainEvents.logIndex, r.logIndex),
              eq(chainEvents.finalized, false),
            ),
          );
      }
      const stored = await ingest(tx, logs, { finalized: true });
      await moveCursor(tx, end);
      return stored;
    });
    fresh.push(...stored);
  });
  // A pass with nothing new still proves the follower alive.
  if (cursor && from > head.number) await moveCursor(deps.db, cursor.block);
  return fresh;
}

/**
 * Stores, not final, every log from the reconciled cursor to `latest`: what a subscription
 * missed while no process held it. Returns the logs stored for the first time.
 */
export async function catchUp(deps: ReconcileDeps): Promise<EventLog[]> {
  const cursor = await finalizedBlock(deps.db);
  if (!cursor) return [];
  const latest = await deps.logs.getBlockNumber({ cacheTime: 0 });
  const fresh: EventLog[] = [];
  await readLogs(deps, cursor.block + 1n, latest, async (logs) => {
    fresh.push(...(await ingest(deps.db, logs, { finalized: false })));
  });
  return fresh;
}

/** Only viem's short message: the full one carries the request URL, which embeds the provider's key. */
const brief = (err: unknown) =>
  err instanceof BaseError ? err.shortMessage : err instanceof Error ? err.message : String(err);

/** The WebSocket of the configured RPC: the explicit URL, or Alchemy's from its HTTPS one. */
export function wssUrl(env: {
  ARBITRUM_SEPOLIA_WSS_URL?: string | undefined;
  ARBITRUM_SEPOLIA_RPC_URL?: string | undefined;
}): string | undefined {
  if (env.ARBITRUM_SEPOLIA_WSS_URL) return env.ARBITRUM_SEPOLIA_WSS_URL;
  const rpc = env.ARBITRUM_SEPOLIA_RPC_URL;
  if (!rpc) return undefined;
  const url = new URL(rpc);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".alchemy.com")) return undefined;
  url.protocol = "wss:";
  return url.toString();
}

const RECONCILE_INTERVAL_MS = 300_000;
/** Longer than a first pass's backfill; two overlapping passes are harmless, only wasteful. */
const RECONCILE_LOCK_MS = 900_000;
const LIVE_RETRY_MS = 10_000;
/** A live holder that stops renewing frees the subscription to another process this soon. */
const LIVE_LOCK_MS = 30_000;
const LIVE_LOCK = "chain:events:live";
const RECONCILE_LOCK = "chain:events:reconcile";

export interface FollowDeps extends ReconcileDeps {
  kv: RedisClientType;
  /** Alchemy's WebSocket; without it the reconciler alone follows the chain. */
  wss?: string | undefined;
  /** Acts on stored events: the new ones, and every one left unhandled. */
  handle(fresh: readonly EventLog[]): Promise<void>;
}

const release = (kv: RedisClientType, key: string, token: string) =>
  kv.eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
    { keys: [key], arguments: [token] },
  );
const renew = (kv: RedisClientType, key: string, token: string, ms: number) =>
  kv.eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) end return 0",
    { keys: [key], arguments: [token, String(ms)] },
  );

/**
 * Follows the vault's and the anchor's events: a subscription over `wss` stores each as it is
 * sequenced, on one process of the deployment at a time, and every five minutes one process
 * reconciles up to `finalized`. Every batch of new events, and every reconcile, runs `handle`.
 */
export function followChainEvents(deps: FollowDeps): {
  stop(): Promise<void>;
  live(): boolean;
} {
  const token = crypto.randomUUID();
  let stopped = false;
  let queue: Promise<void> = Promise.resolve();
  const run = (fresh: readonly EventLog[]) => {
    queue = queue
      .then(() => deps.handle(fresh))
      .catch((err: unknown) => deps.log.warn({ err: brief(err) }, "chain events not handled"));
    return queue;
  };

  let reconciling: Promise<void> | undefined;
  const tick = async () => {
    if (
      (await deps.kv.set(RECONCILE_LOCK, token, {
        NX: true,
        PX: RECONCILE_LOCK_MS,
      })) !== "OK"
    ) {
      return;
    }
    let fresh: EventLog[];
    try {
      fresh = await reconcile(deps);
    } finally {
      await release(deps.kv, RECONCILE_LOCK, token);
    }
    if (fresh.length > 0) deps.log.info({ events: fresh.length }, "chain events reconciled");
    await run(fresh);
  };
  const reconcileNow = () => {
    reconciling ??= tick()
      .catch((err: unknown) => deps.log.warn({ err: brief(err) }, "chain events not reconciled"))
      .finally(() => {
        reconciling = undefined;
      });
  };
  const reconcileTimer = setInterval(reconcileNow, RECONCILE_INTERVAL_MS);
  reconcileTimer.unref();
  reconcileNow();

  let unwatch: (() => void) | undefined;
  let socket: PublicClient | undefined;
  // Batches are stored in order: a removal never runs ahead of the log it removes.
  let writes: Promise<void> = Promise.resolve();
  const drop = () => {
    unwatch?.();
    unwatch = undefined;
    void release(deps.kv, LIVE_LOCK, token).catch(() => {});
    void (socket?.transport as { getRpcClient?: () => Promise<{ close(): void }> } | undefined)
      ?.getRpcClient?.()
      .then((c) => c.close())
      .catch(() => {});
    socket = undefined;
  };
  const subscribe = (url: string) => {
    socket = createPublicClient({ chain: arbitrumSepolia, transport: webSocket(url) });
    unwatch = socket.watchEvent({
      address: [...CONTRACTS],
      events: EVENTS,
      strict: true,
      onLogs: (logs) => {
        const all = logs as unknown as EventLog[];
        writes = writes
          .then(async () => {
            await retract(
              deps.db,
              all.filter((l) => l.removed),
            );
            const fresh = await ingest(deps.db, all, { finalized: false });
            if (fresh.length > 0) {
              deps.log.info({ events: fresh.map((l) => l.eventName) }, "chain events received");
              void run(fresh);
            }
          })
          .catch((err: unknown) => deps.log.warn({ err: brief(err) }, "chain events not stored"));
      },
      onError: (err) => {
        deps.log.warn({ err: brief(err) }, "chain event subscription failed");
        drop();
      },
    });
    deps.log.info("chain event subscription open");
  };
  const liveTick = async () => {
    if (!deps.wss || stopped) return;
    if (unwatch) {
      if ((await renew(deps.kv, LIVE_LOCK, token, LIVE_LOCK_MS)) !== 1) drop();
      return;
    }
    if ((await deps.kv.set(LIVE_LOCK, token, { NX: true, PX: LIVE_LOCK_MS })) !== "OK") return;
    subscribe(deps.wss);
    // What was sequenced while no process held the subscription is read now, not at finality.
    const missed = await catchUp(deps);
    if (missed.length > 0) {
      deps.log.info({ events: missed.length }, "chain events caught up");
      void run(missed);
    }
  };
  const liveTimer = setInterval(() => {
    liveTick().catch((err: unknown) =>
      deps.log.warn({ err: brief(err) }, "chain event subscription not renewed"),
    );
  }, LIVE_RETRY_MS);
  liveTimer.unref();
  void liveTick().catch(() => {});

  return {
    live: () => unwatch !== undefined,
    async stop() {
      stopped = true;
      clearInterval(reconcileTimer);
      clearInterval(liveTimer);
      drop();
      await release(deps.kv, LIVE_LOCK, token);
      await reconciling;
      await writes;
      await queue;
    },
  };
}
