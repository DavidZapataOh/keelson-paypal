import { readFileSync } from "node:fs";
import { type AlibiBundle, decodeAlibi, leafHashOf } from "@keelson/alibi";
import { base64url, exportJWK, generateKeyPair } from "jose";
import { purchaseFacts, statementFacts } from "../src/facts.ts";
import type { ExportSigner } from "../src/signer.ts";
import type { AlibiRef } from "../src/statement.ts";
import { localExportSigner } from "../src/testing.ts";

/** A PayPal purchase, allowed, 2-of-2, full copy with personal disclosures and no disclosed cart. */
export const ALLOW_PAYPAL = "01M6ZWZJHWRRHQEYNJAT7NMSV8";
/** A PayPal cart the enclaves refused, public copy. */
export const DENY_PAYPAL = "01M73ZK3ETHVBBMNZRCBGBDZYJ";
/** A card purchase, allowed, with its cart disclosed, public copy. */
export const ALLOW_CARD = "01M75ZQSJDFE8K76ZKZT08X1B2";

const dir = new URL("./fixtures/", import.meta.url);

/** A production Alibi, as captured. */
export const alibi = (id: string): AlibiBundle =>
  decodeAlibi(new Uint8Array(readFileSync(new URL(`${id}.alibi`, dir)))) as AlibiBundle;

/** A time after every fixture's timestamps, in seconds since the epoch. */
export const NOW = Date.parse("2026-11-11T20:00:00Z") / 1000;

/**
 * The statement reference the exports carry. Until v2 Alibis exist it holds the v1 leaf bytes:
 * real logged bytes, for shape and binding tests; statement verification tests use v2 Alibis.
 */
export function refFor(id: string): AlibiRef {
  const b = alibi(id);
  return {
    statement: base64url.encode(Buffer.from(b.leaf, "base64")),
    leafHash: base64url.encode(leafHashOf(b)),
    uri: `https://api.keelson.finance/v1/alibis/${id}.cose`,
  };
}

/** An issuer over a fresh key that checks bindings against the fixture's countersigned facts. */
export async function testIssuer(id: string): Promise<ExportSigner> {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const facts = statementFacts(purchaseFacts(alibi(id)));
  return localExportSigner(await exportJWK(privateKey), () => facts);
}
