import {
  type AlibiBundle,
  type AlibiReceipt,
  decodeAlibi,
  decodeReceipt,
  fromBase64,
} from "@keelson/alibi";
import {
  type Check,
  createChainReader,
  type Report,
  type Verdict,
  verifyAlibi as verify,
} from "@keelson/alibi/verify";
import canonicalize from "canonicalize";

export type { Check, Report, Verdict };

export interface VerifyAlibiOptions {
  /** Also read the anchor and signer registry on chain: `true` for the public RPCs. */
  chain?: boolean | { rpcUrl: string };
  now?: Date;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Accepts the Alibi as issued (bytes), as base64 or JSON text, or parsed. */
function decode(alibi: Uint8Array | string | object): AlibiBundle | AlibiReceipt {
  let bytes: Uint8Array;
  if (alibi instanceof Uint8Array) bytes = alibi;
  else if (typeof alibi === "string") {
    bytes = alibi.trimStart().startsWith("{") ? encoder.encode(alibi) : fromBase64(alibi.trim());
  } else {
    // A parsed object is put back into RFC 8785 form, the bytes every signature covers.
    bytes = encoder.encode(canonicalize(alibi) as string);
  }
  const parsed = JSON.parse(decoder.decode(bytes)) as object;
  return "type" in parsed ? decodeAlibi(bytes) : decodeReceipt(bytes);
}

/**
 * Verifies an Alibi here, trusting no one: the TEE countersignatures, the evidence and the log
 * inclusion proof. With `chain`, it also reads the on-chain anchor; without, the verdict is at
 * best `verified-offline`.
 */
export async function verifyAlibi(
  alibi: Uint8Array | string | object,
  o: VerifyAlibiOptions = {},
): Promise<Report> {
  const input = decode(alibi);
  const chain =
    o.chain === undefined || o.chain === false
      ? null
      : createChainReader(o.chain === true ? {} : { rpc: rpcFor(input, o.chain.rpcUrl) });
  return verify(input, { chain, ...(o.now ? { now: o.now } : {}) });
}

function rpcFor(input: AlibiBundle | AlibiReceipt, url: string): Record<number, string> {
  const chainId = (input as { anchor?: { chain_id?: number } }).anchor?.chain_id ?? 421614;
  return { [chainId]: url };
}

/** Reads an Alibi from Keelson's API and verifies it here. */
export async function fetchAndVerify(
  purchaseId: string,
  o: VerifyAlibiOptions & { baseUrl?: string } = {},
): Promise<Report> {
  const base = o.baseUrl ?? "https://api.keelson.finance";
  const res = await fetch(`${base}/v1/alibis/${encodeURIComponent(purchaseId)}`);
  if (!res.ok) throw new Error(`No Alibi ${purchaseId}: HTTP ${res.status}`);
  return verifyAlibi(new Uint8Array(await res.arrayBuffer()), o);
}
