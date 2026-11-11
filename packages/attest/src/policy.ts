import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, type Hex, hexToBytes } from "viem";
import { AttestError } from "./errors.ts";
import type { TdxResult } from "./tdx.ts";

/**
 * The TD attributes and XFAM the TDX leg runs with, as the quote states them (little-endian
 * bytes, hex). Taken from the leg's captured quote: DEBUG clear, SEPT_VE_DISABLE set.
 */
export const TDX_POLICY = {
  tdAttributes: ["0x0000001000000000"],
  xfam: ["0x0702000000000000"],
} as const satisfies { tdAttributes: readonly Hex[]; xfam: readonly Hex[] };

/** dstack device ids (SHA-256 of the platform's PPID) the TDX leg may run on. */
export const TDX_DEVICES: readonly Hex[] = [
  "0xc4691f9c88f44e05cbc45521678e72b99fcd54fa35d302f13e8f9fa9727f33a6",
];

/** The dstack `device_id` of a TDX platform: SHA-256 of the PPID its PCK certificate carries. */
export function deviceIdOf(ppid: Uint8Array): Hex {
  return bytesToHex(sha256(ppid));
}

const zero = (b: Uint8Array) => b.every((x) => x === 0);

/**
 * MRCONFIGID as dstack sets it: all zero, or a version byte (1: compose hash; 2 and 3: a hash of
 * the instance's configuration) then 32 bytes then 15 zero bytes. Version 1 must name the
 * attested compose hash.
 */
function configIdHolds(id: Uint8Array, composeHash: Hex): boolean {
  if (zero(id)) return true;
  if (id.length !== 48 || ![1, 2, 3].includes(id[0] as number) || !zero(id.subarray(33))) {
    return false;
  }
  return id[0] !== 1 || bytesToHex(id.subarray(1, 33)) === composeHash.toLowerCase();
}

/**
 * Appraises the TD's own configuration, which neither the measurement id nor dstack's key release
 * covers: TD attributes (DEBUG clear and SEPT_VE_DISABLE set, then the pinned value), XFAM, the
 * owner fields and the device.
 *
 * @throws {AttestError} `td_attributes`, `xfam`, `owner_fields` or `device`.
 */
export function appraiseTd(
  r: Pick<
    TdxResult,
    "tdAttributes" | "xfam" | "mrConfigId" | "mrOwner" | "mrOwnerConfig" | "ppid" | "composeHash"
  >,
  opts: { devices?: readonly Hex[] } = {},
): void {
  const attributes = hexToBytes(r.tdAttributes);
  const debug = ((attributes[0] ?? 0) & 0x01) !== 0;
  const septVeDisabled = ((attributes[3] ?? 0) & 0x10) !== 0;
  if (
    debug ||
    !septVeDisabled ||
    !(TDX_POLICY.tdAttributes as readonly Hex[]).includes(r.tdAttributes)
  ) {
    throw new AttestError("td_attributes", `the TD attributes are ${r.tdAttributes}`);
  }
  if (!(TDX_POLICY.xfam as readonly Hex[]).includes(r.xfam)) {
    throw new AttestError("xfam", `the XFAM is ${r.xfam}`);
  }
  if (
    !zero(hexToBytes(r.mrOwner)) ||
    !zero(hexToBytes(r.mrOwnerConfig)) ||
    !configIdHolds(hexToBytes(r.mrConfigId), r.composeHash)
  ) {
    throw new AttestError("owner_fields", "MROWNER, MROWNERCONFIG or MRCONFIGID is not dstack's");
  }
  const device = deviceIdOf(hexToBytes(r.ppid));
  if (!(opts.devices ?? TDX_DEVICES).includes(device)) {
    throw new AttestError("device", `device ${device} is not allowed`);
  }
}

/** The DER TLV at `at`: its tag, the start of its value and the end of it. */
function tlv(der: Uint8Array, at: number): { tag: number; start: number; end: number } {
  const tag = der[at] as number;
  let len = der[at + 1] as number;
  let start = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | (der[start + i] as number);
    start += n;
  }
  if (start + len > der.length) throw new AttestError("cert_chain", "truncated DER");
  return { tag, start, end: start + len };
}

const PPID = "0x2a864886f84d010d0101";

/**
 * The PPID in the value of a PCK certificate's SGX extensions (1.2.840.113741.1.13.1): a SEQUENCE
 * of SEQUENCE { OID, value }, the PPID an OCTET STRING of 16 bytes.
 */
export function ppidOf(sgxExtensions: Uint8Array): Uint8Array {
  const outer = tlv(sgxExtensions, 0);
  for (let at = outer.start; at < outer.end; ) {
    const entry = tlv(sgxExtensions, at);
    const oid = tlv(sgxExtensions, entry.start);
    if (oid.tag === 0x06 && bytesToHex(sgxExtensions.subarray(oid.start, oid.end)) === PPID) {
      const value = tlv(sgxExtensions, oid.end);
      if (value.tag !== 0x04 || value.end - value.start !== 16) break;
      return sgxExtensions.slice(value.start, value.end);
    }
    at = entry.end;
  }
  throw new AttestError("cert_chain", "the PCK certificate carries no PPID");
}
