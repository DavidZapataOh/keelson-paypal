import type { Erc8004ChainId } from "@keelson/erc8004";
import type { Context } from "hono";
import type { PublicClient } from "viem";
import { problem } from "../problem.ts";

/** How the API reads one chain. */
interface ChainReader {
  /** Contract reads and receipts. */
  client: PublicClient;
  /** `eth_getLogs` over block ranges wider than some providers allow. */
  logs: PublicClient;
}

export type ChainReaders = Partial<Record<Erc8004ChainId, ChainReader>>;

export function chainUnavailable(c: Context, chainId: number) {
  return problem(
    c,
    503,
    "chain-unavailable",
    "Chain unavailable",
    `This server does not read chain ${chainId}.`,
  );
}

/** How long the latest block number is reused before it is asked again: about four Arbitrum blocks. */
const LATEST_BLOCK_MS = 1_000;

/**
 * Memoizes reads per key and block: repeated and concurrent requests within one block share a single
 * read pinned to that block, and a new block always reads again. Holds at most `max` keys.
 */
export function blockScoped(max = 1_024) {
  const entries = new Map<string, { block: bigint; value: Promise<unknown> }>();
  return async <T>(
    client: PublicClient,
    key: string,
    read: (blockNumber: bigint) => Promise<T>,
  ): Promise<{ value: T; hit: boolean }> => {
    const block = await client.getBlockNumber({ cacheTime: LATEST_BLOCK_MS });
    const cached = entries.get(key);
    if (cached && cached.block === block) return { value: (await cached.value) as T, hit: true };
    const entry = { block, value: read(block) };
    entries.delete(key);
    entries.set(key, entry);
    if (entries.size > max) entries.delete(entries.keys().next().value as string);
    try {
      return { value: await entry.value, hit: false };
    } catch (err) {
      if (entries.get(key) === entry) entries.delete(key);
      throw err;
    }
  };
}

/** The block Keelson's ERC-8004 contracts were deployed at; Arbitrum One's registry fork block until they are. */
export const ERC8004_DEPLOY_BLOCK: Record<Erc8004ChainId, bigint> = {
  421614: 327_279_949n,
  42161: 522_274_000n,
  11155111: 12_091_354n,
};
