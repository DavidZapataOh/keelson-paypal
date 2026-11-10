import type { Address } from "viem";
import { addresses, type ChainId, chainIds } from "./addresses.ts";

export * from "./abis.ts";
export { addresses, type ChainId, chainIds } from "./addresses.ts";
export * from "./coverage.ts";
export * from "./permit.ts";
export * from "./reserve.ts";
export * from "./verdict.ts";

/** Role ids of the AccessManager that governs every Keelson contract (`KeelsonRoles.sol`). */
export const roles = {
  ADMIN_ROLE: 0n,
  GUARDIAN_ROLE: 1n,
  PARAMETERS_ROLE: 2n,
  SIGNERS_ROLE: 3n,
  PUBLISHER_ROLE: 4n,
} as const;

/**
 * Deployed Keelson contracts on `chainId`, keyed by contract name.
 * @throws RangeError if Keelson is not deployed on that chain.
 */
export function deploymentsFor(chainId: number): Readonly<Record<string, Address>> {
  if (!(chainIds as readonly number[]).includes(chainId)) {
    throw new RangeError(`Keelson is not deployed on chain ${chainId}`);
  }
  return addresses[chainId as ChainId];
}
