import {
  ALIBI_MEDIA_TYPE,
  type AlibiBundle,
  type AlibiReceipt,
  decodeAlibi,
  decodeReceipt,
  verifyUrl,
} from "@keelson/alibi";
import {
  type ChainReaderOptions,
  type Check,
  type CheckId,
  type CheckStatus,
  createChainReader,
  type Report,
  type Verdict,
  verifyAlibi as verifyReference,
} from "@keelson/alibi/verify";
import { type Json, jcs } from "@keelson/core";
import { unwrap } from "./errors.ts";
import type { Keelson } from "./keelson.ts";

export type {
  AlibiBundle,
  AlibiReceipt,
  ChainReaderOptions,
  Check,
  CheckId,
  CheckStatus,
  Report,
  Verdict,
};
export { verifyUrl };

export interface VerifyAlibiOptions {
  /**
   * Read the on-chain anchor and signer registry too, over these RPCs or the public ones. Left
   * out, nothing is read from any network and the chain checks stay `pending`.
   */
  chain?: ChainReaderOptions | true;
  now?: Date;
}

/**
 * Verifies an Alibi bundle, or its public receipt, on this machine with the same code as the
 * browser verifier at verify.keelson.finance: the passkey-signed mandate, both TEE attestations
 * and countersignatures, the policy replay, log inclusion and witness cosignatures, the RFC 3161
 * timestamps and, with `chain`, the on-chain anchor. Keelson's servers are not asked anything.
 *
 * The verdict is `verified` (or `verified-offline` without `chain`) only if every check passed.
 */
export function verifyAlibi(
  alibi: AlibiBundle | AlibiReceipt | object | Uint8Array | string,
  options: VerifyAlibiOptions = {},
): Promise<Report> {
  // Whatever the input, its schema is checked before any check runs.
  const input = parseAlibi(
    typeof alibi === "string" || alibi instanceof Uint8Array ? alibi : jcs(alibi as Json),
  );
  const chain =
    options.chain === undefined
      ? null
      : createChainReader(options.chain === true ? {} : options.chain);
  return verifyReference(input, { chain, ...(options.now ? { now: options.now } : {}) });
}

/** Decodes an Alibi bundle or receipt from its JSON bytes or text, checking its schema. */
export function parseAlibi(alibi: Uint8Array | string): AlibiBundle | AlibiReceipt {
  const bytes = typeof alibi === "string" ? new TextEncoder().encode(alibi) : alibi;
  const json = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  return "type" in json ? decodeAlibi(bytes) : decodeReceipt(bytes);
}

/** Downloads a purchase's Alibi bundle as Keelson serves it, to keep or verify offline. */
export async function fetchAlibi(keelson: Keelson, purchaseId: string): Promise<AlibiBundle> {
  const bytes = await unwrap(
    keelson.getAlibi({
      path: { id: purchaseId },
      headers: { accept: ALIBI_MEDIA_TYPE },
      parseAs: "arrayBuffer",
    }) as Promise<{ data?: ArrayBuffer; error?: unknown; response?: Response }>,
  );
  return decodeAlibi(new Uint8Array(bytes));
}
