import { readFileSync } from "node:fs";
import { type Json, jcs } from "@keelson/core";
import {
  buildReceipt,
  decodeSign1,
  encodeSign1,
  leafHash,
  RECEIPTS,
  receiptProtected,
  teeCollection,
} from "@keelson/scitt";
import { ed25519PublicKey, signEd25519 } from "@keelson/scitt/testing";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { toBase64 } from "../src/b64.ts";
import { ALIBI_MEDIA_TYPE_V2, type AlibiBundleV2 } from "../src/schema.ts";
import { fixtures } from "./fixtures.ts";

export const ORIGIN = "log.keelson.finance/alibi/2026-1";
const vectors = new URL("../../../internal/alibilog/testdata/statement-v2/", import.meta.url);
export const vector = (name: string) =>
  JSON.parse(readFileSync(new URL(`${name}.json`, vectors), "utf8"));

/** The test receipt key: never deployed. */
export const receiptSecret = sha256(new TextEncoder().encode("keelson alibi v2 test receipt key"));
export const receiptPublic = ed25519PublicKey(receiptSecret);
export const receiptKid = bytesToHex(sha256(receiptPublic));
export const receiptKeys = new Map([[receiptKid, receiptPublic]]);

const node = (l: Uint8Array, r: Uint8Array) => sha256(Uint8Array.of(1, ...l, ...r));

/** A receipt for `entry` at index 1 of a four-entry tree. */
export function receiptFor(entry: Uint8Array): { receipt: Uint8Array; root: Uint8Array } {
  const others = [0, 2, 3].map((i) => leafHash(new TextEncoder().encode(`neighbour ${i}`)));
  const [h0, h2, h3] = others as [Uint8Array, Uint8Array, Uint8Array];
  const h1 = leafHash(entry);
  const root = node(node(h0, h1), node(h2, h3));
  const prot = receiptProtected(sha256(receiptPublic), ORIGIN);
  const signature = signEd25519(prot, root, receiptSecret, { detached: true }).signature;
  return { receipt: buildReceipt(prot, signature, 4n, 1n, [h0, node(h2, h3)]), root };
}

/** The transparent statement: the registered statement with its receipts in label 394. */
export function transparent(statement: Uint8Array, receipts: Uint8Array[]): Uint8Array {
  const s = decodeSign1(statement);
  return encodeSign1({ ...s, unprotected: new Map([[RECEIPTS, receipts]]) });
}

/**
 * A v2 bundle around the `allow-2of2` golden statement: the preimages are the real 2of2 fixture's
 * (whose countersign the statement carries), the legs' keys are the vector test keys.
 */
export function v2Bundle(): AlibiBundleV2 {
  const v1 = fixtures.find((f) => f.mode === "2of2")?.bundle;
  if (!v1) throw new Error("no 2of2 fixture");
  const statement = hexToBytes(vector("allow-2of2").statement_hex);
  const evidence = (kind: "tdx" | "nitro") => {
    const a = v1.tee.attestations.find((x) => x.kind === kind);
    return a ? new TextEncoder().encode(jcs(a as unknown as Json)) : undefined;
  };
  const legs = { tdx: evidence("tdx"), nitro: evidence("nitro") };
  return {
    type: ALIBI_MEDIA_TYPE_V2,
    alibi_id: v1.alibi_id,
    statement: toBase64(transparent(statement, [receiptFor(statement).receipt])),
    tlog_proof: v1.tlog_proof,
    policy: v1.policy,
    attestation: teeCollection(
      Object.fromEntries(Object.entries(legs).filter(([, b]) => b)) as {
        tdx?: Uint8Array;
        nitro?: Uint8Array;
      },
    ) as AlibiBundleV2["attestation"],
    eval: v1.eval,
    mandate: v1.mandate,
    manifest: v1.manifest,
    ...(v1.cart ? { cart: v1.cart } : {}),
    ...(v1.checkout ? { checkout: v1.checkout } : {}),
    ...(v1.zk ? { zk: v1.zk } : {}),
    ...(v1.paypal ? { paypal: v1.paypal } : {}),
  };
}

/** A v2 card purchase: the `card-2of2` statement and its two decisions and settlement, each with a receipt. */
export function cardV2Bundle(): AlibiBundleV2 {
  const { paypal, ...base } = v2Bundle();
  if (!paypal) throw new Error("the base fixture is a PayPal purchase");
  const statement = hexToBytes(vector("card-2of2").statement_hex);
  const card = ["card-auth-approve", "card-auth-decline", "card-settlement"].map((n) => vector(n));
  const withReceipt = (hex: string) => {
    const s = hexToBytes(hex);
    return toBase64(transparent(s, [receiptFor(s).receipt]));
  };
  const authorizations = card.slice(0, 2).map((v, i) => ({
    id: `auth_vector_${i}`,
    amount_minor: v.inputs.facts.amount,
    currency: "USD",
    mcc: v.inputs.facts.mcc,
    merchant_name: "Vector Store",
    merchant_country: "US",
    network_id: "vector-merchant",
    approved: v.inputs.facts.decision === "1",
    verdicts: v.inputs.legs.map(
      (l: { kind: "tdx" | "nitro"; signer: string; signature: string }) => ({
        kind: l.kind,
        authorization: v.inputs.facts,
        digest: `0x${v.digest_hex}`,
        signature: l.signature,
        signer: l.signer,
      }),
    ),
  }));
  return {
    ...base,
    statement: withReceipt(bytesToHex(statement)),
    card: {
      issuer: "lithic",
      card_token: "card_vector_token",
      last_four: "4242",
      ref_salt: paypal.ref_salt,
      controls: {},
      authorizations,
      statements: card.map((v) => withReceipt(v.statement_hex)),
      settlement: {
        transaction_token: "txn_vector",
        settled_minor: card[2].inputs.facts.settledMinor,
        settled_at: new Date(Number(card[2].inputs.facts.settledAt) * 1000).toISOString(),
        raw: toBase64(new TextEncoder().encode("issuer transaction response")),
      },
    },
  } as AlibiBundleV2;
}
