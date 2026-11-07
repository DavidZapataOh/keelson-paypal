import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";
import { hexToBytes } from "viem";
import { AttestError } from "./errors.ts";
import type { NitroPcrs } from "./nitro.ts";
import type { TdxResult } from "./tdx.ts";

const digest = (kind: string, registers: readonly string[]) =>
  `${kind}:${bytesToHex(sha256(concatBytes(...registers.map((r) => hexToBytes(r as `0x${string}`)))))}`;

/**
 * `tdx:` and the SHA-256 of MRTD, RTMR0 to RTMR2, the app id, the compose hash and the OS image
 * hash. RTMR3 is left out: it extends the per-CVM instance id, so it is replayed from the event
 * log and its events are checked instead.
 */
export function tdxMeasurement(
  r: Pick<TdxResult, "mrtd" | "rtmr" | "appId" | "composeHash" | "osImageHash">,
): string {
  if (!r.osImageHash)
    throw new AttestError("binding_mismatch", "the event log has no os-image-hash");
  return digest("tdx", [
    r.mrtd,
    r.rtmr[0],
    r.rtmr[1],
    r.rtmr[2],
    r.appId,
    r.composeHash,
    r.osImageHash,
  ]);
}

/** `nitro:` and the SHA-256 of PCR0, PCR1 and PCR2. */
export function nitroMeasurement(r: { pcrs: Pick<NitroPcrs, 0 | 1 | 2> }): string {
  return digest("nitro", [r.pcrs[0], r.pcrs[1], r.pcrs[2]]);
}
