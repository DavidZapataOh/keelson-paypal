import { type Address, type Chain, parseEther, parseGwei } from "viem";
import { arbitrum, arbitrumSepolia } from "viem/chains";

export type ChainId = 421614 | 42161;

export interface ChainSettings {
  chain: Chain;
  /** The address of the relayer's KMS key on this chain: the client of Keelson's own ERC-8004 feedback. */
  sender: Address;
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
    sender: "0xEd4Aa68f4e0c704422894b072deDa99807Fb2915",
    sequencerUrl: "https://sepolia-rollup-sequencer.arbitrum.io/rpc",
    maxBaseFeeWei: parseGwei("1"),
    minBalanceWei: parseEther("0.01"),
    priorityFeeWei: 0n,
    explorer: "https://sepolia.arbiscan.io",
  },
  42161: {
    chain: arbitrum,
    sender: "0x1f1645054EC4240b9f4BdCc1E14F380Bc827a7c8",
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
