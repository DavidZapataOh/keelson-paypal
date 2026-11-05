import { hashTypedData, type TypedDataDefinition, type TypedDataDomain } from "viem";

export const KEELSON_TYPES = {
  Countersign: [
    { name: "requestId", type: "bytes32" },
    { name: "mandateHash", type: "bytes32" },
    { name: "mandateCommitment", type: "bytes32" },
    { name: "cartHash", type: "bytes32" },
    { name: "agentId", type: "uint256" },
    { name: "merchantId", type: "bytes32" },
    { name: "amount", type: "uint64" },
    { name: "currency", type: "uint16" },
    { name: "category", type: "uint8" },
    { name: "evidenceRoot", type: "bytes32" },
    { name: "evalHash", type: "bytes32" },
    { name: "policySetHash", type: "bytes32" },
    { name: "decision", type: "uint8" },
    { name: "failedFieldsMask", type: "uint32" },
    { name: "issuedAt", type: "uint40" },
    { name: "expiresAt", type: "uint40" },
  ],
  Verdict: [
    { name: "disputeId", type: "bytes32" },
    { name: "coverageId", type: "bytes32" },
    { name: "agentId", type: "uint256" },
    { name: "payee", type: "address" },
    { name: "amount", type: "uint96" },
    { name: "ruleId", type: "uint8" },
    { name: "liable", type: "uint8" },
    { name: "fieldId", type: "uint8" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "inputsHash", type: "bytes32" },
    { name: "policySetHash", type: "bytes32" },
    { name: "checkpointRoot", type: "bytes32" },
    { name: "issuedAt", type: "uint40" },
    { name: "deadline", type: "uint40" },
  ],
  Checkpoint: [
    { name: "origin", type: "bytes32" },
    { name: "treeSize", type: "uint64" },
    { name: "rootHash", type: "bytes32" },
  ],
  Coverage: [
    { name: "coverageId", type: "bytes32" },
    { name: "agentId", type: "uint256" },
    { name: "merchant", type: "address" },
    { name: "amount", type: "uint96" },
    { name: "expiresAt", type: "uint40" },
    { name: "mandateHash", type: "bytes32" },
    { name: "amberCommitment", type: "bytes32" },
  ],
  AmberAttestation: [
    { name: "coverageId", type: "bytes32" },
    { name: "agentId", type: "uint256" },
    { name: "amberCommitment", type: "bytes32" },
  ],
  WithdrawalRequest: [
    { name: "agentId", type: "uint256" },
    { name: "amount", type: "uint128" },
    { name: "to", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  PayoutAddress: [
    { name: "merchant", type: "address" },
    { name: "payout", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  WebFact: [
    { name: "hostHash", type: "bytes32" },
    { name: "urlPathHash", type: "bytes32" },
    { name: "tCapture", type: "uint40" },
    { name: "rangeCommitment", type: "bytes32" },
    { name: "attId", type: "bytes32" },
  ],
} as const;

export type KeelsonPrimaryType = keyof typeof KEELSON_TYPES;

export const CHAIN_IDS = { arbitrumSepolia: 421614, arbitrumOne: 42161 } as const;

export type KeelsonChainId = (typeof CHAIN_IDS)[keyof typeof CHAIN_IDS];

export const Decision = { ALLOW: 1, DENY: 2 } as const;

export const Liable = { OPERATOR: 1, KEELSON: 2, MERCHANT: 3, USER: 4 } as const;

export function keelsonDomain(
  chainId: KeelsonChainId,
  verifyingContract: `0x${string}`,
): { name: "Keelson"; version: "1"; chainId: KeelsonChainId; verifyingContract: `0x${string}` } {
  if (chainId !== CHAIN_IDS.arbitrumSepolia && chainId !== CHAIN_IDS.arbitrumOne) {
    throw new RangeError(`unsupported chain id: ${chainId}`);
  }
  return { name: "Keelson", version: "1", chainId, verifyingContract };
}

function assertUintBounds(primaryType: KeelsonPrimaryType, message: Record<string, unknown>) {
  for (const { name, type } of KEELSON_TYPES[primaryType]) {
    const match = /^uint(\d+)$/.exec(type);
    if (!match) continue;
    const value = message[name];
    if (typeof value !== "bigint" && !Number.isSafeInteger(value)) {
      throw new RangeError(`${primaryType}.${name} must be an integer`);
    }
    const v = BigInt(value as bigint | number);
    if (v < 0n || v >= 1n << BigInt(match[1] as string)) {
      throw new RangeError(`${primaryType}.${name} is out of range for ${type}`);
    }
  }
}

export function hashKeelson<T extends KeelsonPrimaryType>(
  primaryType: T,
  message: TypedDataDefinition<typeof KEELSON_TYPES, T>["message"],
  domain: TypedDataDomain,
): `0x${string}` {
  assertUintBounds(primaryType, message as Record<string, unknown>);
  return hashTypedData({ domain, types: KEELSON_TYPES, primaryType, message } as never);
}
