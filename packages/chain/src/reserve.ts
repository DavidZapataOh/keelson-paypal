import type { Hex } from "viem";
import type { Verdict } from "./verdict.ts";

/** The arguments of `KeelsonReserve.payWarranty`: a warranty needs both legs' signatures. */
export function payWarrantyArgs(
  verdict: Verdict,
  treeSize: bigint,
  signatures: { tdx: Hex; nitro: Hex },
) {
  return [verdict, treeSize, `${signatures.tdx}${signatures.nitro.slice(2)}` as Hex] as const;
}
