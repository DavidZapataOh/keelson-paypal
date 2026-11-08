import {
  type Address,
  concat,
  encodeAbiParameters,
  type Hex,
  hashTypedData,
  isAddress,
  keccak256,
  stringToHex,
  type TypedDataDefinition,
  type TypedDataDomain,
} from "viem";

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
    { name: "premium", type: "uint96" },
    { name: "expiresAt", type: "uint40" },
    { name: "mandateHash", type: "bytes32" },
    { name: "amberCommitment", type: "bytes32" },
  ],
  CoverageBatch: [
    { name: "agentId", type: "uint256" },
    { name: "root", type: "bytes32" },
    { name: "total", type: "uint128" },
    { name: "premium", type: "uint96" },
    { name: "expiresAt", type: "uint40" },
    { name: "checkpointRoot", type: "bytes32" },
    { name: "treeSize", type: "uint64" },
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
  Claim: [
    { name: "account", type: "address" },
    { name: "to", type: "address" },
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

function assertMessage(primaryType: KeelsonPrimaryType, message: Record<string, unknown>) {
  for (const { name, type } of KEELSON_TYPES[primaryType]) {
    const value = message[name];
    if (type === "bytes32") {
      if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new TypeError(`${primaryType}.${name} must be a 32-byte hex string`);
      }
      continue;
    }
    if (type === "address") {
      if (typeof value !== "string" || !isAddress(value)) {
        throw new TypeError(`${primaryType}.${name} must be an address`);
      }
      continue;
    }
    const match = /^uint(\d+)$/.exec(type);
    if (!match) continue;
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
  assertMessage(primaryType, message as Record<string, unknown>);
  return hashTypedData({ domain, types: KEELSON_TYPES, primaryType, message } as never);
}

export type Countersign = TypedDataDefinition<typeof KEELSON_TYPES, "Countersign">["message"];

function assertChain(chainId: unknown): void {
  if (chainId !== undefined && typeof chainId !== "bigint" && typeof chainId !== "number") {
    throw new RangeError("unsupported chain id");
  }
  const id = chainId === undefined ? undefined : Number(chainId);
  if (id !== CHAIN_IDS.arbitrumSepolia && id !== CHAIN_IDS.arbitrumOne) {
    throw new RangeError(`unsupported chain id: ${String(chainId)}`);
  }
}

/** The EIP-712 signing hash of a `Countersign`; only Arbitrum Sepolia and Arbitrum One domains. */
export function countersignDigest(c: Countersign, domain: TypedDataDomain): Hex {
  assertChain(domain.chainId);
  return hashKeelson("Countersign", c, domain);
}

/** The `failedFieldsMask` bit of each policy `@id`. Append-only. */
export const FIELD_BITS = {
  agent: 0,
  sanity: 1,
  currency: 2,
  amount: 3,
  budget: 4,
  merchant: 5,
  window: 6,
  quantity: 7,
  category: 8,
  variant: 9,
  returns: 10,
  returns_free: 11,
} as const;

/** Set when any fired policy is outside the base table (a user extra such as `extra.0`). */
export const BIT_EXTRA = 28;
/** Set when the canonicalizer denied the cart. */
export const BIT_CANON = 29;
/** Set when Cedar reported diagnostics errors. */
export const BIT_CEDAR_ERROR = 30;
/** Set when the PayPal order check failed. */
export const BIT_PAYPAL = 31;

/** Builds `failedFieldsMask` from the fired policy ids and the fault flags. */
export function failedFieldsMask(
  fired: readonly string[],
  faults: { errors?: boolean; canon?: boolean; paypal?: boolean },
): number {
  let mask = 0;
  for (const id of fired) {
    const bit = Object.hasOwn(FIELD_BITS, id)
      ? FIELD_BITS[id as keyof typeof FIELD_BITS]
      : id === "base"
        ? undefined
        : BIT_EXTRA;
    if (bit !== undefined) mask |= 1 << bit;
  }
  if (faults.canon) mask |= 1 << BIT_CANON;
  if (faults.errors) mask |= 1 << BIT_CEDAR_ERROR;
  if (faults.paypal) mask |= 1 << BIT_PAYPAL;
  return mask >>> 0;
}

export const TeeKind = { TDX: 1, NITRO: 2 } as const;

/** Everything a TEE attestation binds the countersign signer to. */
export interface SignerBinding {
  chainId: bigint;
  bondVault: Address;
  teeKind: (typeof TeeKind)[keyof typeof TeeKind];
  signer: Address;
  policySetHash: Hex;
  engineBuildId: Hex;
  bootEpoch: bigint;
  /** RFC 7638 SHA-256 thumbprint of the credential issuer's public JWK. */
  issuerJwkThumbprint: Hex;
}

const SIGNER_TAG = keccak256(stringToHex("KEELSON_TEE_SIGNER_V1"));

/**
 * The 64-byte `report_data` of a TEE attestation: the keccak256 of the ABI-encoded binding,
 * followed by a recent L2 block hash.
 */
export function reportData(b: SignerBinding, blockHash: Hex): Hex {
  assertChain(b.chainId);
  if (b.teeKind !== TeeKind.TDX && b.teeKind !== TeeKind.NITRO) {
    throw new RangeError(`unknown tee kind: ${String(b.teeKind)}`);
  }
  if (b.bootEpoch < 0n || b.bootEpoch >= 1n << 64n) {
    throw new RangeError("bootEpoch is out of range for uint64");
  }
  const binding = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint8" },
        { type: "address" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint64" },
        { type: "bytes32" },
      ],
      [
        SIGNER_TAG,
        b.chainId,
        b.bondVault,
        b.teeKind,
        b.signer,
        b.policySetHash,
        b.engineBuildId,
        b.bootEpoch,
        b.issuerJwkThumbprint,
      ],
    ),
  );
  if (!/^0x[0-9a-fA-F]{64}$/.test(blockHash)) throw new TypeError("blockHash must be 32 bytes");
  return concat([binding, blockHash]).toLowerCase() as Hex;
}
