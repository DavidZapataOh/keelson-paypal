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

/** The block Keelson's ERC-8004 contracts were deployed at; Arbitrum One's registry fork block until they are. */
export const ERC8004_DEPLOY_BLOCK: Record<Erc8004ChainId, bigint> = {
  421614: 327_279_949n,
  42161: 522_274_000n,
  11155111: 12_091_354n,
};
