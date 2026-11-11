import { type Json, jcs } from "@keelson/core";
import { decodeSign1, encodeSign1, RECEIPTS, teeCollection } from "@keelson/scitt";
import { toBase64 } from "./b64.ts";
import { ALIBI_MEDIA_TYPE_V2, type AlibiBundle, type AlibiBundleV2 } from "./schema.ts";

const encoder = new TextEncoder();

/**
 * A v1 Alibi carried into v2: `statement` is the bridge statement leg A signed over the v1
 * countersigned facts as the log registered it, `receipts` its RFC 9942 receipts, `tlogProof` its
 * inclusion proof, and the v1 leaf rides along as its predecessor. Every other section is the v1 one; the v1 timestamps and anchor cover the v1 leaf,
 * not the statement, so they stay with the v1 bundle, as does a v1 card settlement, which no leg
 * read from the issuer.
 */
export function bridgeBundle(
  v1: AlibiBundle,
  statement: Uint8Array,
  receipts: Uint8Array[],
  tlogProof: string,
): AlibiBundleV2 {
  const transparent = encodeSign1({
    ...decodeSign1(statement),
    unprotected: new Map([[RECEIPTS, receipts]]),
  });
  const evidence = (kind: "tdx" | "nitro") => {
    const a = v1.tee.attestations.find((x) => x.kind === kind);
    return a ? encoder.encode(jcs(a as unknown as Json)) : undefined;
  };
  const tdx = evidence("tdx");
  const nitro = evidence("nitro");
  const {
    type: _,
    leaf,
    leaf_view: __,
    tee: ___,
    tlog_proof: ____,
    anchor: _____,
    timestamps: ______,
    card,
    ...rest
  } = v1;
  return {
    ...rest,
    type: ALIBI_MEDIA_TYPE_V2,
    statement: toBase64(transparent),
    tlog_proof: tlogProof,
    predecessor: leaf,
    attestation: teeCollection({
      ...(tdx ? { tdx } : {}),
      ...(nitro ? { nitro } : {}),
    }) as AlibiBundleV2["attestation"],
    ...(card ? { card: { ...withoutSettlement(card), statements: [] } } : {}),
  };
}

function withoutSettlement<T extends { settlement?: unknown }>(card: T): Omit<T, "settlement"> {
  const { settlement: _, ...rest } = card;
  return rest;
}
