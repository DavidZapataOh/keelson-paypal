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
