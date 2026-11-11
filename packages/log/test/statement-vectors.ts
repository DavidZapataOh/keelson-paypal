import { hexToBytes } from "@noble/hashes/utils.js";
import type { Hex } from "viem";
import type {
  CardAuthorizationClaims,
  CardSettlementClaims,
  LegSignature,
  StatementClaims,
} from "../src/statement.ts";

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

export const CARD_VECTOR_NAMES = [
  "card-auth-approve",
  "card-auth-decline",
  "card-settlement",
] as const;

const CARD_UINTS = [
  "mcc",
  "amount",
  "currency",
  "decision",
  "failedMask",
  "issuedAt",
  "settledMinor",
  "status",
  "settledAt",
  "observedAt",
];

interface CardVector {
  kind: "card-authorization" | "card-settlement";
  inputs: {
    facts: Record<string, string>;
    parent: Hex;
    card_ref?: Hex;
    chain_id: number;
    verifying_contract: Hex;
    mode: "2of2" | "degraded";
    legs: LegSignature[];
  };
}

export function cardFromVector(
  v: CardVector,
):
  | { kind: "card-authorization"; claims: CardAuthorizationClaims }
  | { kind: "card-settlement"; claims: CardSettlementClaims } {
  const facts = Object.fromEntries(
    Object.entries(v.inputs.facts).map(([k, x]) => [k, CARD_UINTS.includes(k) ? BigInt(x) : x]),
  );
  const signed = {
    chainId: v.inputs.chain_id,
    verifyingContract: v.inputs.verifying_contract,
    mode: v.inputs.mode,
    legs: v.inputs.legs as StatementClaims["legs"],
    parent: v.inputs.parent,
  };
  return v.kind === "card-authorization"
    ? {
        kind: v.kind,
        claims: {
          ...signed,
          authorization: facts as unknown as CardAuthorizationClaims["authorization"],
          cardRef: v.inputs.card_ref as Hex,
        },
      }
    : {
        kind: v.kind,
        claims: { ...signed, settlement: facts as unknown as CardSettlementClaims["settlement"] },
      };
}
