import { DST, hashObject, type Json, sha256 } from "@keelson/core";
import { BN254_FR_MODULUS } from "@keelson/core/poseidon2";

const PREFIX = new TextEncoder().encode(DST.mandateChallenge);

/** `H_sd = H("keelson/mandate/v1", payload_SD)`: the payload with its `_sd` digests, without disclosures. */
export function hSd(payloadSd: object): Uint8Array {
  return hashObject(DST.mandate, payloadSd as Json);
}

/**
 * The passkey challenge `M = SHA-256("keelson/mandate-challenge/v1" || 0x00 || H_sd || C_m)`,
 * with `C_m` as 32 bytes big-endian.
 */
export function mandateChallenge(hSd: Uint8Array, cm: bigint): Uint8Array {
  if (hSd.length !== 32) throw new RangeError("H_sd must be 32 bytes");
  if (cm < 0n || cm >= BN254_FR_MODULUS) throw new RangeError("C_m is not a field element");
  const input = new Uint8Array(PREFIX.length + 1 + 64);
  input.set(PREFIX, 0);
  input.set(hSd, PREFIX.length + 1);
  const be32 = input.subarray(PREFIX.length + 33);
  for (let i = 31, v = cm; i >= 0; i--, v >>= 8n) be32[i] = Number(v & 0xffn);
  return sha256(input);
}
