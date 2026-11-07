import { bytesToHex } from "@noble/hashes/utils.js";
import type * as asn1js from "asn1js";
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
    const tstInfo = pkijs.TSTInfo.fromBER(eContent.getValue());
    return {
      signedData,
      tstInfo,
      genTime: tstInfo.genTime,
      serial: bytesToHex(tstInfo.serialNumber.valueBlock.valueHexView),
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

function accuracyMs(accuracy: pkijs.Accuracy | undefined): number | null {
  if (!accuracy) return null;
  return (accuracy.seconds ?? 0) * 1000 + (accuracy.millis ?? 0) + (accuracy.micros ?? 0) / 1000;
}

/** The DER bytes of an element exactly as received. */
export function received(element: asn1js.AsnType): Uint8Array {
  return new Uint8Array(element.valueBeforeDecodeView);
}
