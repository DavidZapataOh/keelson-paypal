import type { Address } from "viem";

export const erc8004ChainIds = [421614, 42161, 11155111] as const;

export type Erc8004ChainId = (typeof erc8004ChainIds)[number];

/** The official ERC-8004 v2.0.0 registries Keelson reads, per chain. */
export const ERC8004: Readonly<Record<Erc8004ChainId, { identity: Address; reputation: Address }>> =
  {
    421614: {
      identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    },
    42161: {
      identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
    },
    11155111: {
      identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    },
  };

export function isErc8004ChainId(chainId: number): chainId is Erc8004ChainId {
  return (erc8004ChainIds as readonly number[]).includes(chainId);
}

/** The `agentRegistry` of the chain's Identity registry: `eip155:{chainId}:{identity}`. */
export function agentRegistry(chainId: Erc8004ChainId): string {
  return `eip155:${chainId}:${ERC8004[chainId].identity}`;
}
