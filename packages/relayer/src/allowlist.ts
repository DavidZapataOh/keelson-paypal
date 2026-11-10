import {
  iPYUSDAbi,
  keelsonBondVaultAbi,
  keelsonReputationReporterAbi,
  keelsonReserveAbi,
  keelsonValidationRegistryAbi,
  verdictVerifierAbi,
} from "@keelson/chain";
import { type Abi, type Address, parseAbi } from "viem";
import type { ChainId } from "./chains.ts";

/**
 * The calls the relayer pays for: permissionless functions of Keelson's contracts that authenticate their caller
 * by signature or read their own state, PYUSD's EIP-3009 transfer that its signer authorized, and Keelson's own
 * feedback to the ERC-8004 Reputation registry. Nothing else is simulated or signed.
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
  PYUSD: ["transferWithAuthorization"],
  ReputationRegistry: ["giveFeedback"],
} as const;

export type ContractName = keyof typeof ALLOWLIST;
export type FunctionName<C extends ContractName> = (typeof ALLOWLIST)[C][number];

/** The relayable contracts Keelson did not deploy, per chain (`contracts/deployments/<chainId>.json`). */
export const EXTERNAL: Record<
  ChainId,
  Readonly<Record<"PYUSD" | "ReputationRegistry", Address>>
> = {
  421614: {
    PYUSD: "0x637A1259C6afd7E3AdF63993cA7E58BB438aB1B1",
    ReputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  },
  42161: {
    PYUSD: "0x46850aD61C2B7d64d08c9C754F45254596696984",
    ReputationRegistry: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
  },
};

export const ABIS = {
  KeelsonBondVault: keelsonBondVaultAbi,
  KeelsonReserve: keelsonReserveAbi,
  VerdictVerifier: verdictVerifierAbi,
  KeelsonValidationRegistry: keelsonValidationRegistryAbi,
  KeelsonReputationReporter: keelsonReputationReporterAbi,
  // PaxosTokenV2's EIP-3009 transfer in its `bytes signature` form.
  PYUSD: parseAbi([
    "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
  ]),
  ReputationRegistry: parseAbi([
    "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  ]),
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
