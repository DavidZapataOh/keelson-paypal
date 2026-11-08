import { type Chain, parseEther, parseGwei } from "viem";
import { arbitrum, arbitrumSepolia } from "viem/chains";

export type ChainId = 421614 | 42161;

export interface ChainSettings {
  chain: Chain;
  /** The sequencer's public endpoint, which answers `eth_sendRawTransactionSync` with the receipt. */
  sequencerUrl: string;
  /** Above this base fee nothing is sent. */
  maxBaseFeeWei: bigint;
  /** Below this balance the relayer is degraded and refuses submissions. */
  minBalanceWei: bigint;
  priorityFeeWei: bigint;
  explorer: string;
}

export const CHAINS: Record<ChainId, ChainSettings> = {
  421614: {
    chain: arbitrumSepolia,
    sequencerUrl: "https://sepolia-rollup-sequencer.arbitrum.io/rpc",
    maxBaseFeeWei: parseGwei("1"),
    minBalanceWei: parseEther("0.01"),
    priorityFeeWei: 0n,
    explorer: "https://sepolia.arbiscan.io",
  },
  42161: {
    chain: arbitrum,
    sequencerUrl: "https://arb1-sequencer.arbitrum.io/rpc",
    maxBaseFeeWei: parseGwei("0.1"),
    minBalanceWei: parseEther("0.0005"),
    priorityFeeWei: 0n,
    explorer: "https://arbiscan.io",
  },
};

export function isChainId(id: number): id is ChainId {
  return id === 421614 || id === 42161;
}
