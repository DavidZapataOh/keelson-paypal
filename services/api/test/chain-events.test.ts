import { randomBytes } from "node:crypto";
import { chainCursors, chainEvents, eq } from "@keelson/db";
import type { Relayer, SubmitRequest } from "@keelson/relayer";
import { pino } from "pino";
import { bytesToHex, type Hex, type PublicClient } from "viem";
import { beforeEach, describe, expect, test } from "vitest";
import {
  BACKFILL_BLOCKS,
  CONTRACTS,
  catchUp,
  type EventLog,
  finalizedBlock,
  ingest,
  isFinal,
  reconcile,
  retract,
  wssUrl,
} from "../src/chain/events.ts";
import { dueCoverages, releaseCoverages } from "../src/onchain/validations.ts";
import { testDb } from "./setup.ts";

const log = pino({ level: "silent" });
const id = (): Hex => bytesToHex(randomBytes(32));

function event(
  name: string,
  args: Record<string, unknown>,
  blockNumber: bigint,
  logIndex = 0,
  txHash: Hex = id(),
): EventLog {
  return {
    address: CONTRACTS[0] as Hex,
    blockHash: id(),
    blockNumber,
    data: "0x",
    logIndex,
    transactionHash: txHash,
    transactionIndex: 0,
    removed: false,
    topics: [],
    eventName: name,
    args,
  } as EventLog;
}

/**
 * A logs RPC over `logs` whose `finalized` block is `head`, refusing ranges wider than `limit`;
 * `hashes` are the canonical block hashes.
 */
function chain(head: bigint, logs: EventLog[], limit = 10_000n, hashes = new Map<bigint, Hex>()) {
  const calls: [bigint, bigint][] = [];
  const client = {
    getBlock: async ({ blockNumber }: { blockNumber?: bigint } = {}) =>
      blockNumber === undefined
        ? { number: head }
        : { number: blockNumber, hash: hashes.get(blockNumber) ?? id() },
    getBlockNumber: async () => head + 100n,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      if (toBlock - fromBlock + 1n > limit) throw new Error("range too wide");
      calls.push([fromBlock, toBlock]);
      return logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
  } as unknown as PublicClient;
  return { client, calls };
}

beforeEach(async () => {
  await testDb.delete(chainEvents);
  await testDb.delete(chainCursors);
});

describe("the event projection", () => {
  test("stores each log once, however often it is seen", async () => {
    const e = event("CoverageReleased", { coverageId: id(), amount: 5n }, 100n);
    expect(await ingest(testDb, [e], { finalized: false })).toHaveLength(1);
    expect(await ingest(testDb, [e], { finalized: false })).toHaveLength(0);
    expect(await ingest(testDb, [e], { finalized: true })).toHaveLength(0);
    const rows = await testDb.select().from(chainEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.args).toEqual({ coverageId: e.args.coverageId, amount: "5" });
    expect(rows[0]?.finalized).toBe(true);
    // Final stays final: a late live copy does not undo it.
    await ingest(testDb, [e], { finalized: false });
    expect((await testDb.select().from(chainEvents))[0]?.finalized).toBe(true);
  });

  test("a removed log is dropped while not final", async () => {
    const e = event("CoverageLocked", { coverageId: id() }, 100n);
    await ingest(testDb, [e], { finalized: false });
    await retract(testDb, [{ ...e, removed: true }]);
    expect(await testDb.select().from(chainEvents)).toHaveLength(0);
  });
});

describe("the reconciler", () => {
  test("starts a week below finalized, in chunks the provider takes, and keeps a cursor", async () => {
    const head = 400_000_000n;
    const start = head - BACKFILL_BLOCKS;
    const logs = [event("CoverageLocked", { coverageId: id() }, start + 25_000n)];
    const rpc = chain(head, logs, 5_000n);
    const fresh = await reconcile({ db: testDb, logs: rpc.client, log });
    expect(fresh).toHaveLength(1);
    expect(rpc.calls[0]?.[0]).toBe(start);
    expect(rpc.calls.every(([from, to]) => to - from < 5_000n)).toBe(true);
    expect(rpc.calls.at(-1)?.[1]).toBe(head);
    expect((await finalizedBlock(testDb))?.block).toBe(head);

    // The next pass reads only the new finalized blocks.
    const next = chain(head + 1_200n, logs);
    expect(await reconcile({ db: testDb, logs: next.client, log })).toHaveLength(0);
    expect(next.calls).toEqual([[head + 1n, head + 1_200n]]);
  });

  test("deletes what a reorg removed and finalizes what stayed", async () => {
    await testDb.insert(chainCursors).values({ chainId: 421614, block: 999n });
    const kept = event("CoverageLocked", { coverageId: id() }, 1_005n);
    const orphan = event("CoverageReleased", { coverageId: id() }, 1_006n);
    const ahead = event("CoverageReleased", { coverageId: id() }, 2_000n);
    await ingest(testDb, [kept, orphan, ahead], { finalized: false });
    // The canonical chain kept one log, in another block of the same transaction.
    const moved = { ...kept, blockNumber: 1_007n, blockHash: id() };
    await reconcile({ db: testDb, logs: chain(1_500n, [moved]).client, log });
    const rows = await testDb.select().from(chainEvents).orderBy(chainEvents.blockNumber);
    expect(rows.map((r) => [r.blockNumber, r.finalized])).toEqual([
      [1_007n, true],
      // Past finalized: left to a later pass.
      [2_000n, false],
    ]);
  });

  test("keeps a live log a node missed in a canonical block, and the cursor where it was", async () => {
    await testDb.insert(chainCursors).values({ chainId: 421614, block: 999n });
    const live = event("CoverageLocked", { coverageId: id() }, 1_005n);
    await ingest(testDb, [live], { finalized: false });
    // The node answers no log, yet block 1,005 still has the hash the log was seen in.
    const lagging = chain(1_500n, [], 10_000n, new Map([[1_005n, live.blockHash as Hex]]));
    await expect(reconcile({ db: testDb, logs: lagging.client, log })).rejects.toThrow(
      /miss a log/,
    );
    expect(await testDb.select().from(chainEvents)).toHaveLength(1);
    expect((await finalizedBlock(testDb))?.block).toBe(999n);
  });

  test("the cursor never moves back", async () => {
    await testDb.insert(chainCursors).values({ chainId: 421614, block: 2_000n });
    await reconcile({ db: testDb, logs: chain(1_500n, []).client, log });
    expect((await finalizedBlock(testDb))?.block).toBe(2_000n);
  });

  test("catching up stores, not final, what was sequenced past the cursor", async () => {
    await testDb.insert(chainCursors).values({ chainId: 421614, block: 1_000n });
    const missed = event("CheckpointAnchored", { origin: id(), size: 7n }, 1_050n);
    const rpc = chain(1_000n, [missed]);
    expect(await catchUp({ db: testDb, logs: rpc.client, log })).toHaveLength(1);
    expect(rpc.calls).toEqual([[1_001n, 1_100n]]);
    expect((await testDb.select().from(chainEvents))[0]?.finalized).toBe(false);
  });

  test("a payment is final once the cursor passed it and the node's receipt agrees", async () => {
    await testDb.insert(chainCursors).values({ chainId: 421614, block: 1_000n });
    const receipts = new Map<Hex, { status: string; blockNumber: bigint }>();
    const client = {
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        const r = receipts.get(hash);
        if (!r) throw new Error("not found");
        return r;
      },
    } as unknown as PublicClient;
    const final = isFinal(testDb, client);
    const [a, b, c] = [id(), id(), id()];
    receipts.set(a, { status: "success", blockNumber: 900n });
    // Reorganized into a later block, past finalized.
    receipts.set(b, { status: "success", blockNumber: 1_200n });
    expect(await final({ hash: a, block: 900n })).toBe(true);
    expect(await final({ hash: a, block: 1_100n })).toBe(false);
    expect(await final({ hash: b, block: 900n })).toBe(false);
    // Dropped by a reorg.
    expect(await final({ hash: c, block: 900n })).toBe(false);
  });

  test("a failed range leaves the cursor where it was", async () => {
    await testDb.insert(chainCursors).values({ chainId: 421614, block: 999n });
    const rpc = chain(1_500n, [], 10n);
    await expect(reconcile({ db: testDb, logs: rpc.client, log })).rejects.toThrow();
    expect((await finalizedBlock(testDb))?.block).toBeLessThan(1_500n);
  });
});

describe("the release scheduler", () => {
  const now = () => BigInt(Math.floor(Date.now() / 1000));
  const sent: SubmitRequest[] = [];
  const relayer = {
    submit: async (req: SubmitRequest) => {
      sent.push(req);
      return { id: "tx", status: "confirmed" };
    },
  } as unknown as Relayer;
  const deps = {
    db: testDb,
    log,
    relayer,
    chain: { client: {} as PublicClient },
  };
  beforeEach(() => {
    sent.length = 0;
  });

  test("releases only coverages past their window, not released, with no slash pending", async () => {
    const [due, early, released, pending, vetoed] = [id(), id(), id(), id(), id()];
    const lock = (c: Hex, releaseAfter: bigint) =>
      event("CoverageLocked", { coverageId: c, releaseAfter }, 10n);
    const [disputeA, disputeB] = [id(), id()];
    await ingest(
      testDb,
      [
        lock(due, now() - 60n),
        lock(early, now() + 3_600n),
        lock(released, now() - 60n),
        lock(pending, now() - 60n),
        lock(vetoed, now() - 60n),
        event("CoverageReleased", { coverageId: released }, 11n),
        event("SlashQueued", { coverageId: pending, disputeId: disputeA }, 11n),
        event("SlashQueued", { coverageId: vetoed, disputeId: disputeB }, 11n),
        event("SlashVetoed", { disputeId: disputeB, reason: "veto" }, 12n),
      ],
      { finalized: false },
    );
    expect(new Set(await dueCoverages(testDb))).toEqual(new Set([due, vetoed]));
    expect(await releaseCoverages(deps)).toBe(2);
    expect(sent.map((r) => [r.functionName, r.key])).toEqual(
      expect.arrayContaining([
        ["releaseCoverage", `KeelsonBondVault.releaseCoverage:${due}`],
        ["releaseCoverage", `KeelsonBondVault.releaseCoverage:${vetoed}`],
      ]),
    );
  });

  test("asks the chain nothing when nothing is due", async () => {
    expect(await releaseCoverages(deps)).toBe(0);
    expect(sent).toHaveLength(0);
  });
});

test("the subscription uses Alchemy's WebSocket, or the one configured", () => {
  const key = "k";
  const alchemy = `https://arb-sepolia.g.alchemy.com/v2/${key}`;
  expect(wssUrl({ ARBITRUM_SEPOLIA_RPC_URL: alchemy })).toBe(alchemy.replace("https:", "wss:"));
  expect(wssUrl({ ARBITRUM_SEPOLIA_RPC_URL: "https://rpc.example/" })).toBeUndefined();
  expect(
    wssUrl({
      ARBITRUM_SEPOLIA_WSS_URL: "wss://ws.example/",
      ARBITRUM_SEPOLIA_RPC_URL: alchemy,
    }),
  ).toBe("wss://ws.example/");
});

test("an event row is keyed by chain, transaction and log index", async () => {
  const tx = id();
  await ingest(
    testDb,
    [
      event("Slashed", { coverageId: id() }, 5n, 0, tx),
      event("Slashed", { coverageId: id() }, 5n, 1, tx),
    ],
    { finalized: true },
  );
  expect(
    await testDb.select().from(chainEvents).where(eq(chainEvents.chainId, 421614)),
  ).toHaveLength(2);
});
