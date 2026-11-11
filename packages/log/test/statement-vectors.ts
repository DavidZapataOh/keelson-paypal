import { hexToBytes } from "@noble/hashes/utils.js";
import type { Hex } from "viem";
import type { LegSignature, StatementClaims } from "../src/statement.ts";

export const VECTOR_NAMES = ["allow-2of2", "deny-2of2", "allow-degraded", "card-2of2"] as const;

/** The vector legs' secp256k1 keys: tdx = 0x01…01, nitro = 0x02…02. Test keys, never deployed. */
export const vectorKeys = [hexToBytes("01".repeat(32)), hexToBytes("02".repeat(32))] as const;

export interface StatementVector {
  name: string;
  inputs: {
    alibi_id: string;
    countersign: Record<string, string>;
    chain_id: number;
    verifying_contract: Hex;
    mode: "2of2" | "degraded";
    legs: LegSignature[];
    pay_ref?: Hex;
  };
  claims_hex: string;
  protected_hex: string;
  tbs_hex: string;
  statement_hex: string;
  leaf_hash_hex: string;
}

const UINTS = [
  "agentId",
  "amount",
  "currency",
  "category",
  "decision",
  "failedFieldsMask",
  "issuedAt",
  "expiresAt",
];

export function fromVector(v: StatementVector): { claims: StatementClaims; alibiId: string } {
  const c = v.inputs.countersign;
  const countersign = Object.fromEntries(
    Object.entries(c).map(([k, x]) => [k, UINTS.includes(k) ? BigInt(x) : x]),
  ) as unknown as StatementClaims["countersign"];
  return {
    alibiId: v.inputs.alibi_id,
    claims: {
      countersign,
      chainId: v.inputs.chain_id,
      verifyingContract: v.inputs.verifying_contract,
      mode: v.inputs.mode,
      legs: v.inputs.legs as StatementClaims["legs"],
      ...(v.inputs.pay_ref ? { payRef: v.inputs.pay_ref } : {}),
    },
  };
}
