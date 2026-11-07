import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { TimestampError } from "./errors.ts";
import { imprintMatches, parseToken, received, SHA256_OID } from "./token.ts";
import { TSAS, type TsaId } from "./tsas.ts";

/** A token a TSA granted over an imprint, as received. */
export interface Stamp {
  tsa: TsaId;
  /** DER `TimeStampToken` (CMS `ContentInfo`). */
  token: Uint8Array;
  genTime: Date;
  /** Serial number, hex. */
  serial: string;
  /** TSA policy OID. */
  policy: string;
  accuracyMs: number | null;
  nonce: bigint;
  latencyMs: number;
}

const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
/** A reply with a full certificate chain is under 8 KiB; anything near this is not a TSA's. */
const MAX_REPLY_BYTES = 64 * 1024;

/**
 * Asks a TSA for an RFC 3161 token over a SHA-256 hash. `imprint` is the hash itself: it is sent as
 * the `hashedMessage`, so the token verifies with `openssl ts -verify -digest <imprint hex>`.
 */
export async function requestTimestamp(
  tsa: TsaId | { id: TsaId; url: string },
  imprint: Uint8Array,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Stamp> {
  if (imprint.length !== 32) throw new RangeError("imprint must be a 32-byte SHA-256 hash");
  const { id, url } = typeof tsa === "string" ? { id: tsa, url: TSAS[tsa].url } : tsa;

  const nonceBytes = crypto.getRandomValues(new Uint8Array(8));
  // A positive INTEGER with a minimal DER encoding.
  nonceBytes[0] = (nonceBytes[0] as number) & 0x7f || 0x01;
  const nonce = new asn1js.Integer({ valueHex: nonceBytes });
  const request = new pkijs.TimeStampReq({
    version: 1,
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: SHA256_OID }),
      hashedMessage: new asn1js.OctetString({ valueHex: imprint }),
    }),
    nonce,
    certReq: true,
  });

  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  const started = performance.now();
  let body: Uint8Array;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/timestamp-query" },
      body: new Uint8Array(request.toSchema().toBER()),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new TimestampError("tsa-http", `${id} answered HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
    if (contentType !== "application/timestamp-reply") {
      await response.body?.cancel();
      throw new TimestampError("tsa-content-type", `${id} answered ${contentType ?? "no type"}`);
    }
    body = await readCapped(response, id);
  } catch (error) {
    if (error instanceof TimestampError) throw error;
    if (timeout.aborted) {
      throw new TimestampError("tsa-timeout", `${id} did not answer in time`, { cause: error });
    }
    throw new TimestampError("tsa-http", `${id} request failed`, { cause: error });
  }
  const latencyMs = Math.round(performance.now() - started);

  let response: pkijs.TimeStampResp;
  let schema: asn1js.Sequence;
  try {
    const asn = asn1js.fromBER(body);
    if (asn.offset === -1) throw new Error(asn.result.error);
    schema = asn.result as asn1js.Sequence;
    response = new pkijs.TimeStampResp({ schema });
  } catch (error) {
    throw new TimestampError("tsa-parse", `${id} sent a malformed TimeStampResp`, { cause: error });
  }
  if (response.status.status > pkijs.PKIStatus.grantedWithMods) {
    throw new TimestampError("tsa-status", `${id} refused: status ${response.status.status}`);
  }
  const tokenElement = schema.valueBlock.value[1];
  if (!tokenElement) throw new TimestampError("tsa-parse", `${id} granted without a token`);
  const token = received(tokenElement);

  const parsed = parseToken(token);
  if (!imprintMatches(parsed.tstInfo, imprint)) {
    throw new TimestampError("tsa-imprint", `${id} stamped a different imprint`);
  }
  if (Math.abs(parsed.genTime.getTime() - Date.now()) > MAX_CLOCK_SKEW_MS) {
    throw new TimestampError("tsa-time", `${id} genTime is more than 5 min off the local clock`);
  }
  const echoed = parsed.tstInfo.nonce?.toBigInt();
  if (echoed !== nonce.toBigInt()) {
    throw new TimestampError("tsa-nonce", `${id} returned a different nonce`);
  }
  return {
    tsa: id,
    token,
    genTime: parsed.genTime,
    serial: parsed.serial,
    policy: parsed.policy,
    accuracyMs: parsed.accuracyMs,
    nonce: echoed,
    latencyMs,
  };
}

async function readCapped(response: Response, id: string): Promise<Uint8Array> {
  const tooLarge = () => new TimestampError("tsa-http", `${id} sent a reply over 64 KiB`);
  if (Number(response.headers.get("content-length") ?? 0) > MAX_REPLY_BYTES) {
    await response.body?.cancel();
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > MAX_REPLY_BYTES) {
      await response.body?.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(chunk);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.length;
  }
  return body;
}
