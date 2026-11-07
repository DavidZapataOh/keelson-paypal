import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { TimestampError } from "./errors.ts";

/** id-sha256 (RFC 5754). */
export const SHA256_OID = "2.16.840.1.101.3.4.2.1";

/** The parts of a TimeStampToken (RFC 3161 §2.4.2) the request and the verifier read. */
export interface ParsedToken {
  signedData: pkijs.SignedData;
  tstInfo: pkijs.TSTInfo;
  genTime: Date;
  serial: string;
  policy: string;
  accuracyMs: number | null;
}

/** More certificates than any TSA sends is refused before any path is built. */
const MAX_CERTIFICATES = 8;

/** Parses a DER `TimeStampToken` (a CMS `ContentInfo` holding `SignedData` over a `TSTInfo`). */
export function parseToken(token: Uint8Array): ParsedToken {
  try {
    const contentInfo = pkijs.ContentInfo.fromBER(token as Uint8Array<ArrayBuffer>);
    if (contentInfo.contentType !== pkijs.ContentInfo.SIGNED_DATA) {
      throw new Error(`content type ${contentInfo.contentType}`);
    }
    const signedData = new pkijs.SignedData({ schema: contentInfo.content });
    const eContent = signedData.encapContentInfo.eContent;
    if (signedData.encapContentInfo.eContentType !== pkijs.id_eContentType_TSTInfo || !eContent) {
      throw new Error("the token does not hold a TSTInfo");
    }
    if ((signedData.certificates?.length ?? 0) > MAX_CERTIFICATES) {
      throw new Error("too many certificates");
    }
    const tstInfoDer = eContent.getValue();
    // RFC 3161 §2.4.2: genTime is a GeneralizedTime in UTC, ending in Z.
    const raw = asn1js.fromBER(tstInfoDer).result as asn1js.Sequence;
    const genTimeField = raw.valueBlock.value[4];
    const encoded = genTimeField?.valueBeforeDecodeView;
    if (!(genTimeField instanceof asn1js.GeneralizedTime) || encoded?.at(-1) !== 0x5a) {
      throw new Error("genTime is not a UTC GeneralizedTime");
    }
    const tstInfo = pkijs.TSTInfo.fromBER(tstInfoDer);
    return {
      signedData,
      tstInfo,
      genTime: tstInfo.genTime,
      serial: evenHex(tstInfo.serialNumber.toBigInt()),
      policy: tstInfo.policy,
      accuracyMs: accuracyMs(tstInfo.accuracy),
    };
  } catch (error) {
    if (error instanceof TimestampError) throw error;
    throw new TimestampError("tsa-parse", "malformed TimeStampToken", { cause: error });
  }
}

/** Whether the token's message imprint is SHA-256 over exactly `imprint`. */
export function imprintMatches(tstInfo: pkijs.TSTInfo, imprint: Uint8Array): boolean {
  const { hashAlgorithm, hashedMessage } = tstInfo.messageImprint;
  const hashed = hashedMessage.valueBlock.valueHexView;
  return (
    hashAlgorithm.algorithmId === SHA256_OID &&
    hashed.length === imprint.length &&
    hashed.every((byte, i) => byte === imprint[i])
  );
}

function evenHex(value: bigint): string {
  const hex = value.toString(16);
  return hex.length % 2 ? `0${hex}` : hex;
}

function accuracyMs(accuracy: pkijs.Accuracy | undefined): number | null {
  if (!accuracy) return null;
  return (accuracy.seconds ?? 0) * 1000 + (accuracy.millis ?? 0) + (accuracy.micros ?? 0) / 1000;
}

/** The DER bytes of an element exactly as received. */
export function received(element: asn1js.AsnType): Uint8Array {
  return new Uint8Array(element.valueBeforeDecodeView);
}
