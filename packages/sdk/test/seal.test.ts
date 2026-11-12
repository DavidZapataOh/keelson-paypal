import { cartHash as coreCartHash, toHex } from "@keelson/core";
import { buildManifest, canonicalBytes as coreCanonical, MEDIA_TYPES } from "@keelson/evidence";
import { closeMandate as coreClose, verifyKeyBinding } from "@keelson/mandate";
import { describe, expect, test } from "vitest";
import { cartHash, closeMandate, importAgentKey } from "../src/agent-key.ts";
import { canonicalBytes, manifestOf, sealedItems } from "../src/seal.ts";
import type { Cart } from "../src/types.ts";

const salt = (b: number) => new Uint8Array(32).fill(b);
const cart: Cart = {
  merchant: "mrc_runfast",
  currency: "USD",
  lines: [{ sku: "nike-pegasus-41", size: "10", category: "footwear", qty: 1, unit_minor: 11900 }],
  return_days: 30,
  returns_free: true,
};

describe("sealing evidence", () => {
  test("the manifest and its root are the ones @keelson/evidence builds", () => {
    const items = sealedItems(
      {
        product: { handle: "nike-pegasus-41", title: "Pegasus 41" },
        cart,
        observation: "Size 10, $119.",
      },
      [salt(1), salt(2), salt(3)],
    );
    expect(items.map((i) => i.type)).toEqual(["api.product", "api.cart", "llm.observation"]);
    expect(items.map((i) => i.mediaType)).toEqual([
      MEDIA_TYPES["api.product"],
      MEDIA_TYPES["api.cart"],
      MEDIA_TYPES["llm.observation"],
    ]);
    expect(manifestOf(items)).toEqual(buildManifest(items));
  });

  test("canonical bytes are RFC 8785, as @keelson/evidence writes them", () => {
    const value = { b: [1, 2.5, "é"], a: { z: null, y: true } };
    expect(canonicalBytes(value)).toEqual(coreCanonical(value));
  });

  test("an observation is required and items keep the manifest order", () => {
    expect(() => sealedItems({ observation: "" }, [])).toThrow(/observation/);
    expect(sealedItems({ observation: "x" }, [salt(9)]).map((i) => i.type)).toEqual([
      "llm.observation",
    ]);
  });
});

describe("closing a mandate with the agent's key", () => {
  const jwt = (payload: object) =>
    `${Buffer.from('{"alg":"ES256"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.c2ln`;
  const open = `${jwt({ iss: "a" })}~WyJhIl0~~${jwt({ _sd_alg: "sha-256", iss: "b" })}~WyJiIl0~`;
  const requestId = "01JC3XQ7ZK8M4N6P9R2T5V7W0Y";

  test("the cart hash is @keelson/core's", () => {
    expect(cartHash(cart)).toBe(`sha256:${toHex(coreCartHash(cart)).slice(2)}`);
  });

  test("the key binding matches @keelson/mandate's and verifies against the agent's key", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const key = await importAgentKey(jwk);
    const iat = 1_800_000_000;
    const mine = await closeMandate(open, { requestId, cart, iat }, key);
    const theirs = await coreClose(
      open,
      { requestId, cartHash: cartHash(cart), iat },
      pair.privateKey,
    );
    const head = (t: string) => t.split(".").slice(0, 2).join(".");
    expect(head(mine.slice(open.length))).toBe(head(theirs.slice(open.length)));
    const { kty, crv, x, y } = jwk;
    await expect(
      verifyKeyBinding(mine, { kty, crv, x, y } as never, {
        requestId,
        cartHash: cartHash(cart),
        now: iat,
        maxSkewSec: 60,
      }),
    ).resolves.toBe(iat);
  });

  test("a key that is not a private P-256 JWK is refused", async () => {
    await expect(importAgentKey({ kty: "EC", crv: "P-384" })).rejects.toThrow(/P-256/);
  });
});
