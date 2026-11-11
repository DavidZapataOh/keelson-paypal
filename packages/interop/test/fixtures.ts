import { readFileSync } from "node:fs";
import { type AlibiBundle, decodeAlibi } from "@keelson/alibi";

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
