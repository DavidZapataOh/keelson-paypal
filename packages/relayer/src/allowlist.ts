import {
  iPYUSDAbi,
  keelsonBondVaultAbi,
  keelsonReputationReporterAbi,
  keelsonReserveAbi,
  keelsonValidationRegistryAbi,
  verdictVerifierAbi,
} from "@keelson/chain";
import type { Abi } from "viem";

/**
 * The calls the relayer pays for: permissionless functions of Keelson's contracts that authenticate their caller
 * by signature or read their own state. Nothing else is simulated or signed.
 */
export const ALLOWLIST = {
  KeelsonBondVault: [
    "depositWithAuthorization",
    "depositWithPermit",
    "lockCoverage",
    "lockCoverageBatch",
    "releaseCoverage",
    "releaseBatch",
    "requestWithdrawal",
    "completeWithdrawal",
    "setPayoutAddress",
    "slash",
    "slashBatched",
    "executeSlash",
    "claim",
  ],
  KeelsonReserve: ["payWarranty", "claim"],
  VerdictVerifier: ["reportEquivocation"],
  KeelsonValidationRegistry: ["recordCountersign", "recordOutcome"],
  KeelsonReputationReporter: ["rateCoverage"],
} as const;

export type ContractName = keyof typeof ALLOWLIST;
export type FunctionName<C extends ContractName> = (typeof ALLOWLIST)[C][number];

export const ABIS = {
  KeelsonBondVault: keelsonBondVaultAbi,
  KeelsonReserve: keelsonReserveAbi,
  VerdictVerifier: verdictVerifierAbi,
  KeelsonValidationRegistry: keelsonValidationRegistryAbi,
  KeelsonReputationReporter: keelsonReputationReporterAbi,
} as const satisfies Record<ContractName, Abi>;

/** Every custom error a relayed call can revert with, its own contract's or one it calls. */
export const ERRORS: Abi = [...Object.values(ABIS).flat(), ...iPYUSDAbi].filter((item, i, all) => {
  if (item.type !== "error") return false;
  return all.findIndex((other) => other.type === "error" && other.name === item.name) === i;
});

export function isAllowed(contract: string, functionName: string): contract is ContractName {
  return (
    Object.hasOwn(ALLOWLIST, contract) &&
    (ALLOWLIST[contract as ContractName] as readonly string[]).includes(functionName)
  );
}
