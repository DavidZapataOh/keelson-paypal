import { readFileSync } from "node:fs";
import { type AlibiBundle, decodeAlibi } from "@keelson/alibi";
import { exportJWK, generateKeyPair } from "jose";
import { type EcPublicJwk, type Signer, signerOf } from "../src/jose.ts";

/**
 * Production Alibis: a sandbox purchase PayPal captured (the mandate's user, with every
 * disclosure) and a live cart Keelson refused (the public copy).
 */
export const ALLOWED = "01M6ZWZJHWRRHQEYNJAT7NMSV8";
export const DENIED = "01M73ZK3ETHVBBMNZRCBGBDZYJ";

export const alibi = (id: string): AlibiBundle =>
  decodeAlibi(readFileSync(new URL(`fixtures/${id}.alibi`, import.meta.url)));

/** A fresh ES256 key. */
export async function freshSigner(): Promise<Signer> {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  return signerOf(privateKey, (await exportJWK(publicKey)) as EcPublicJwk);
}
