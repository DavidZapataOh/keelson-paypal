import type { Address, TypedDataDefinition } from "viem";
import { addresses } from "./addresses.ts";

/** PYUSD on Arbitrum Sepolia, the token the bond vault holds. */
export const PYUSD_ARBITRUM_SEPOLIA: Address = "0x637A1259C6afd7E3AdF63993cA7E58BB438aB1B1";

const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** An EIP-2612 permit of PYUSD to the bond vault; `nonce` is `PYUSD.nonces(owner)`. */
export interface BondPermit {
  owner: Address;
  value: bigint;
  nonce: bigint;
  deadline: bigint;
}

/**
 * The EIP-2612 `Permit` an agent's owner signs so the vault's `depositWithPermit` pulls `value`
 * PYUSD into the agent's bond. PYUSD's domain is `{ name: "PayPal USD", version: "1" }`.
 */
export function bondPermitTypedData(
  permit: BondPermit,
): TypedDataDefinition<typeof PERMIT_TYPES, "Permit"> {
  return {
    domain: {
      name: "PayPal USD",
      version: "1",
      chainId: 421614,
      verifyingContract: PYUSD_ARBITRUM_SEPOLIA,
    },
    types: PERMIT_TYPES,
    primaryType: "Permit",
    message: { ...permit, spender: addresses[421614].KeelsonBondVault as Address },
  };
}
