import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import canonicalize from "canonicalize";
import { KeelsonError } from "./errors.ts";
import type { Cart } from "./types.ts";

const encoder = new TextEncoder();
const b64url = (b: Uint8Array | string) =>
  Buffer.from(typeof b === "string" ? encoder.encode(b) : b).toString("base64url");

/** The agent's P-256 `cnf` key, from its private JWK (`KEELSON_AGENT_KEY`). */
export async function importAgentKey(jwk: JsonWebKey | string): Promise<CryptoKey> {
  const key = typeof jwk === "string" ? (JSON.parse(jwk) as JsonWebKey) : jwk;
  if (key.kty !== "EC" || key.crv !== "P-256" || !key.d || !key.x || !key.y) {
    throw new KeelsonError("The agent key is not a private P-256 JWK.");
  }
  return crypto.subtle.importKey("jwk", key, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
  ]);
}

/** `sha256:<hex>` of `"keelson/cart/v1" ‖ 0x00 ‖ JCS(cart)`, absent size or color as `null`. */
export function cartHash(cart: Cart): string {
  const body = canonicalize({
    merchant: cart.merchant,
    currency: cart.currency,
    lines: cart.lines.map((l) => ({
      sku: l.sku,
      size: l.size ?? null,
      color: l.color ?? null,
      category: l.category,
      qty: l.qty,
      unit_minor: l.unit_minor,
    })),
    return_days: cart.return_days,
    returns_free: cart.returns_free,
  }) as string;
  const prefix = encoder.encode("keelson/cart/v1");
  const json = encoder.encode(body);
  const input = new Uint8Array(prefix.length + 1 + json.length);
  input.set(prefix);
  input.set(json, prefix.length + 1);
  return `sha256:${bytesToHex(sha256(input))}`;
}

/**
 * Closes an open mandate for one request: appends a KB-JWT signed by the agent's key that binds
 * the request id as `nonce` and the cart as `cart_hash` (RFC 9901 §4.3).
 */
export async function closeMandate(
  openMandate: string,
  o: { requestId: string; cart: Cart; iat?: number },
  agentKey: CryptoKey,
): Promise<string> {
  const tail = openMandate.slice(openMandate.indexOf("~~") + 2);
  if (!openMandate.endsWith("~") || !openMandate.includes("~~") || tail === "") {
    throw new KeelsonError("Not an open mandate.");
  }
  const header = b64url(JSON.stringify({ typ: "kb+jwt", alg: "ES256" }));
  const payload = b64url(
    JSON.stringify({
      iat: o.iat ?? Math.floor(Date.now() / 1000),
      aud: "keelson.finance/countersign",
      nonce: o.requestId,
      sd_hash: b64url(sha256(encoder.encode(tail))),
      cart_hash: cartHash(o.cart),
    }),
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    agentKey,
    encoder.encode(`${header}.${payload}`),
  );
  return `${openMandate}${header}.${payload}.${b64url(new Uint8Array(signature))}`;
}
