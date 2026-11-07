import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";
import { hexToBytes } from "viem";
import type { NitroResult } from "./nitro.ts";
import type { TdxResult } from "./tdx.ts";

const digest = (kind: string, registers: readonly string[]) =>
  `${kind}:${bytesToHex(sha256(concatBytes(...registers.map((r) => hexToBytes(r as `0x${string}`)))))}`;

/** `tdx:` and the SHA-256 of MRTD and RTMR0 to RTMR3. */
export function tdxMeasurement(r: Pick<TdxResult, "mrtd" | "rtmr">): string {
  return digest("tdx", [r.mrtd, ...r.rtmr]);
}

/** `nitro:` and the SHA-256 of PCR0, PCR1 and PCR2. */
export function nitroMeasurement(r: Pick<NitroResult, "pcrs">): string {
  return digest("nitro", [r.pcrs[0], r.pcrs[1], r.pcrs[2]]);
}
