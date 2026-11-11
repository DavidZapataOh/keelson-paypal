import { type Json, jcs } from "@keelson/core";
import { decodeSign1, encodeSign1, RECEIPTS, teeCollection } from "@keelson/scitt";
import { toBase64 } from "./b64.ts";
import { ALIBI_MEDIA_TYPE_V2, type AlibiBundle, type AlibiBundleV2 } from "./schema.ts";

const encoder = new TextEncoder();

/** The sections a v1 and a v2 Alibi share: everything but the leaf, its proof and the legs' answer. */
export type SharedSections = Omit<
  AlibiBundle,
  "type" | "leaf" | "leaf_view" | "tlog_proof" | "tee" | "anchor" | "timestamps" | "card"
> & { card?: AlibiBundle["card"] | undefined };

/**
 * A v2 Alibi: `statement` as the log registered it with its RFC 9942 `receipts` in label 394,
 * `tlogProof` its inclusion proof, the legs' evidence as an RFC 9999 collection, and the shared
 * sections. A card's own statements are added as they are logged.
 */
export function statementBundle(o: {
  sections: SharedSections;
  attestations: AlibiBundle["tee"]["attestations"];
  statement: Uint8Array;
  receipts: Uint8Array[];
  tlogProof: string;
}): AlibiBundleV2 {
  const evidence = (kind: "tdx" | "nitro") => {
    const a = o.attestations.find((x) => x.kind === kind);
    return a ? encoder.encode(jcs(a as unknown as Json)) : undefined;
  };
  const tdx = evidence("tdx");
  const nitro = evidence("nitro");
  const transparent = encodeSign1({
    ...decodeSign1(o.statement),
    unprotected: new Map(o.receipts.length ? [[RECEIPTS, o.receipts]] : []),
  });
  const { card, ...sections } = o.sections;
  return {
    ...sections,
    type: ALIBI_MEDIA_TYPE_V2,
    statement: toBase64(transparent),
    tlog_proof: o.tlogProof,
    attestation: teeCollection({
      ...(tdx ? { tdx } : {}),
      ...(nitro ? { nitro } : {}),
    }) as AlibiBundleV2["attestation"],
    ...(card ? { card: { ...withoutSettlement(card), statements: [] } } : {}),
  };
}

/**
 * A v1 Alibi carried into v2: `statement` is the bridge statement leg A signed over the v1
 * countersigned facts as the log registered it, `receipts` its RFC 9942 receipts, `tlogProof` its
 * inclusion proof, and the v1 leaf rides along as its predecessor. Every other section is the v1
 * one; the v1 timestamps and anchor cover the v1 leaf, not the statement, so they stay with the v1
 * bundle, as does a v1 card settlement, which no leg read from the issuer.
 */
export function bridgeBundle(
  v1: AlibiBundle,
  statement: Uint8Array,
  receipts: Uint8Array[],
  tlogProof: string,
): AlibiBundleV2 {
  const {
    type: _,
    leaf,
    leaf_view: __,
    tee,
    tlog_proof: ___,
    anchor: ____,
    timestamps: _____,
    ...sections
  } = v1;
  return {
    ...statementBundle({
      sections,
      attestations: tee.attestations,
      statement,
      receipts,
      tlogProof,
    }),
    predecessor: leaf,
  };
}

function withoutSettlement<T extends { settlement?: unknown }>(card: T): Omit<T, "settlement"> {
  const { settlement: _, ...rest } = card;
  return rest;
}
