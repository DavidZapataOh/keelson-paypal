import { KEELSON_TYPES, type KeelsonChainId, keelsonDomain } from "@keelson/core/eip712";
import { type Address, concat, type Hex, type TypedDataDefinition } from "viem";
import type { CountersignMode, Coverage } from "./coverage.ts";

export type Verdict = TypedDataDefinition<typeof KEELSON_TYPES, "Verdict">["message"];
export type Claim = TypedDataDefinition<typeof KEELSON_TYPES, "Claim">["message"];

/** A verdict's signatures: `tdx ‖ nitro` for 2-of-2, `tdx` alone while the Nitro leg is down. */
export function verdictSigs(
  mode: CountersignMode,
  signatures: { tdx: Hex; nitro: Hex | null },
): Hex {
  if (mode === "degraded") return signatures.tdx;
  if (!signatures.nitro) throw new TypeError("a 2-of-2 verdict needs the Nitro signature");
  return concat([signatures.tdx, signatures.nitro]);
}

/**
 * The arguments of `KeelsonBondVault.slash`. `treeSize` is the anchored size whose root the
 * verdict names (`CheckpointAnchor.rootAt(logOrigin, treeSize)`).
 */
export function slashArgs(
  verdict: Verdict,
  treeSize: bigint,
  mode: CountersignMode,
  signatures: { tdx: Hex; nitro: Hex | null },
) {
  return [verdict, treeSize, verdictSigs(mode, signatures)] as const;
}

/** The arguments of `KeelsonBondVault.slashBatched`: the coverage and its proof in the batch. */
export function slashBatchedArgs(
  verdict: Verdict,
  treeSize: bigint,
  mode: CountersignMode,
  signatures: { tdx: Hex; nitro: Hex | null },
  batchId: Hex,
  coverage: Coverage,
  proof: readonly Hex[],
) {
  return [verdict, treeSize, verdictSigs(mode, signatures), batchId, coverage, proof] as const;
}

/**
 * The `Claim` an account signs to have its failed payouts sent to `to`, under the domain of the
 * contract that holds them (`KeelsonBondVault` or `KeelsonReserve`); `nonce` is that contract's
 * `nonces(account)`.
 */
export function claimTypedData(
  claim: Claim,
  chainId: KeelsonChainId,
  verifyingContract: Address,
): TypedDataDefinition<typeof KEELSON_TYPES, "Claim"> {
  return {
    domain: keelsonDomain(chainId, verifyingContract),
    types: KEELSON_TYPES,
    primaryType: "Claim",
    message: claim,
  };
}
