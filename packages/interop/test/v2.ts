import { readFileSync } from "node:fs";
import { ALIBI_MEDIA_TYPE_V2, type AlibiBundleV2, toBase64 } from "@keelson/alibi";
import { type Json, jcs } from "@keelson/core";
import {
  buildReceipt,
  decodeSign1,
  encodeSign1,
  leafHash,
  RECEIPTS,
  receiptProtected,
  rootFromInclusion,
  teeCollection,
} from "@keelson/scitt";
import { ed25519PublicKey, signEd25519 } from "@keelson/scitt/testing";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base64url } from "jose";
import type { AlibiRef } from "../src/statement.ts";
import { alibi } from "./fixtures.ts";

/**
 * Transparent Statements for tests: the golden v2 statements the log's statement vectors define,
 * each given an RFC 9942 receipt by a fixed test receipt key over a two-leaf tree.
 */
const vectors = new URL("../../../internal/alibilog/testdata/statement-v2/", import.meta.url);
const ORIGIN = "log.keelson.finance/alibi/2026-1";
const secret = sha256(new TextEncoder().encode("keelson interop test receipt key"));
const publicKey = ed25519PublicKey(secret);
const kid = sha256(publicKey);

/** The receipt keys a verifier pins, by hex key id. */
export const RECEIPT_KEYS: ReadonlyMap<string, Uint8Array> = new Map([
  [bytesToHex(kid), publicKey],
]);

/** The registered statement of a golden vector. */
export const registered = (vector: string): Uint8Array =>
  hexToBytes(
    (
      JSON.parse(readFileSync(new URL(`${vector}.json`, vectors), "utf8")) as {
        statement_hex: string;
      }
    ).statement_hex,
  );

/** A Transparent Statement for `statement`: the statement with one receipt in label 394. */
export function transparent(statement: Uint8Array): Uint8Array {
  const sibling = leafHash(new TextEncoder().encode("another entry"));
  const root = rootFromInclusion(leafHash(statement), 0n, 2n, [sibling]);
  const prot = receiptProtected(kid, ORIGIN);
  const signature = signEd25519(prot, root, secret, { detached: true }).signature;
  const receipt = buildReceipt(prot, signature, 2n, 0n, [sibling]);
  return encodeSign1({ ...decodeSign1(statement), unprotected: new Map([[RECEIPTS, [receipt]]]) });
}

/** The reference an export carries for a golden vector's statement. */
export function v2Ref(vector: string): AlibiRef {
  const statement = registered(vector);
  const id = decodeAlibiId(statement);
  return {
    statement: base64url.encode(transparent(statement)),
    leafHash: base64url.encode(leafHash(statement)),
    uri: `https://api.keelson.finance/v1/alibis/${id}.cose`,
  };
}

function decodeAlibiId(statement: Uint8Array): string {
  const json = readdirVectors().find((v) => bytesToHex(registered(v)) === bytesToHex(statement));
  const inputs = JSON.parse(readFileSync(new URL(`${json}.json`, vectors), "utf8")).inputs as {
    alibi_id: string;
  };
  return inputs.alibi_id;
}

const readdirVectors = () => [
  "allow-2of2",
  "deny-2of2",
  "card-2of2",
  "allow-degraded",
  "bridge-2of2",
  "card-auth-approve",
];

/**
 * A v2 bundle around a production v1 Alibi: its sections as they are, with the golden statement
 * whose countersign is the Alibi's and that statement's receipt, and its legs' evidence as a CMW
 * collection.
 */
export function v2Of(id: string, vector = "allow-2of2"): AlibiBundleV2 {
  const v1 = alibi(id);
  const evidence = (kind: "tdx" | "nitro") => {
    const a = v1.tee.attestations.find((x) => x.kind === kind);
    return a ? new TextEncoder().encode(jcs(a as unknown as Json)) : undefined;
  };
  const legs = Object.fromEntries(
    (["tdx", "nitro"] as const).flatMap((k) => (evidence(k) ? [[k, evidence(k)]] : [])),
  ) as { tdx?: Uint8Array; nitro?: Uint8Array };
  return {
    type: ALIBI_MEDIA_TYPE_V2,
    alibi_id: v1.alibi_id,
    statement: toBase64(transparent(registered(vector))),
    tlog_proof: v1.tlog_proof,
    policy: v1.policy,
    attestation: teeCollection(legs) as AlibiBundleV2["attestation"],
    eval: v1.eval,
    mandate: v1.mandate,
    manifest: v1.manifest,
    ...(v1.cart ? { cart: v1.cart } : {}),
    ...(v1.checkout ? { checkout: v1.checkout } : {}),
    ...(v1.zk ? { zk: v1.zk } : {}),
    ...(v1.paypal ? { paypal: v1.paypal } : {}),
  };
}
