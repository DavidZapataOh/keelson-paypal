import { readFileSync } from "node:fs";
import { p256 } from "@noble/curves/nist.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vitest";
import {
  decodeSign1,
  encodeSign1,
  sigStructure,
  verifyEd25519,
  verifyEd25519Message,
  verifyEs256k,
  verifyEs256kMessage,
} from "../src/sign1.ts";
import { ed25519PublicKey, signEd25519, signEs256k } from "../src/testing.ts";

const dir = new URL("./vectors/", import.meta.url);
const json = (path: string) => JSON.parse(readFileSync(new URL(path, dir), "utf8"));
const b64url = (s: string) => Uint8Array.from(Buffer.from(s, "base64url"));

describe("cose-wg sign1 vectors", () => {
  test("sign-pass-01 (protected sent as a0) and sign-pass-03 (no tag) are refused when strict", () => {
    for (const f of ["sign-pass-01", "sign-pass-03"]) {
      const bytes = hexToBytes(json(`cose-wg/${f}.json`).output.cbor.toLowerCase());
      expect(() => decodeSign1(bytes)).toThrow(expect.objectContaining({ code: "format" }));
    }
  });
  test.each(["sign-pass-02.json"])("%s: Sig_structure and round trip", (file) => {
    const v = json(`cose-wg/${file}`);
    const bytes = hexToBytes(v.output.cbor.toLowerCase());
    const s = decodeSign1(bytes, { strict: false });
    const external = v.input.sign0.external ? hexToBytes(v.input.sign0.external) : undefined;
    const tbs = sigStructure(s.protected, s.payload as Uint8Array, external);
    expect(bytesToHex(tbs)).toBe(v.intermediates.ToBeSign_hex.toLowerCase());
    expect(encodeSign1(s)).toEqual(bytes);
    const k = v.input.sign0.key;
    const pub = p256.Point.fromAffine({
      x: BigInt(`0x${bytesToHex(b64url(k.x))}`),
      y: BigInt(`0x${bytesToHex(b64url(k.y))}`),
    }).toBytes(false);
    expect(p256.verify(s.signature, tbs, pub, { lowS: false })).toBe(true);
  });
});

describe("Wycheproof secp256k1 (ECDSA with SHA-256)", () => {
  const w = json("wycheproof/ecdsa_secp256k1_sha256_test.json");
  const cases = w.testGroups.flatMap(
    (g: { publicKey: { uncompressed: string }; tests: unknown[] }) =>
      g.tests.map((t) => ({ key: hexToBytes(g.publicKey.uncompressed), ...(t as object) })),
  ) as { key: Uint8Array; tcId: number; msg: string; sig: string; result: string }[];

  test("every valid low-S case verifies, every invalid case fails", () => {
    let checked = 0;
    let highS = 0;
    for (const c of cases) {
      let compact: Uint8Array | null = null;
      try {
        compact = secp256k1.Signature.fromBytes(hexToBytes(c.sig), "der").toBytes("compact");
      } catch {
        compact = null;
      }
      const ok = compact !== null && verifyEs256kMessage(hexToBytes(c.msg), compact, c.key);
      if (c.result === "valid") {
        const sig = secp256k1.Signature.fromBytes(compact as Uint8Array, "compact");
        if (sig.hasHighS()) {
          highS++;
          expect(ok, `tcId ${c.tcId}: high-S must be refused`).toBe(false);
        } else {
          expect(ok, `tcId ${c.tcId}`).toBe(true);
        }
      } else if (c.result === "invalid") {
        expect(ok, `tcId ${c.tcId}`).toBe(false);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(400);
    expect(highS).toBeGreaterThan(0);
  });
});

describe("Wycheproof ed25519", () => {
  const w = json("wycheproof/ed25519_test.json");
  test("every case passes or fails as labelled", () => {
    for (const g of w.testGroups) {
      const key = hexToBytes(g.publicKey.pk);
      for (const t of g.tests) {
        const ok = verifyEd25519Message(hexToBytes(t.msg), hexToBytes(t.sig), key);
        if (t.result !== "acceptable") expect(ok, `tcId ${t.tcId}`).toBe(t.result === "valid");
      }
    }
  });
});

describe("COSE_Sign1 with ES256K and Ed25519", () => {
  const sk = hexToBytes("01".repeat(32));
  const pub = secp256k1.getPublicKey(sk, false);
  const address = keccak_256(pub.subarray(1)).subarray(12);
  const protectedBytes = hexToBytes("a1013830"); // {1: -47}
  const payload = new TextEncoder().encode("payload");

  test("an ES256K signature verifies by public key and by address", () => {
    const s = signEs256k(protectedBytes, payload, sk);
    expect(verifyEs256k(s, pub)).toBe(true);
    expect(verifyEs256k(s, address)).toBe(true);
    expect(verifyEs256k(decodeSign1(encodeSign1(s)), address)).toBe(true);
  });

  test("a high-S ES256K signature is refused", () => {
    const s = signEs256k(protectedBytes, payload, sk);
    const sig = secp256k1.Signature.fromBytes(s.signature, "compact");
    const flipped = new secp256k1.Signature(sig.r, secp256k1.Point.CURVE().n - sig.s);
    expect(verifyEs256k({ ...s, signature: flipped.toBytes("compact") }, pub)).toBe(false);
  });

  test("a detached payload is verified against the payload given", () => {
    const edSk = sha256(new TextEncoder().encode("receipt key"));
    const s = signEd25519(hexToBytes("a10132"), payload, edSk, { detached: true });
    expect(s.payload).toBeNull();
    const key = ed25519PublicKey(edSk);
    expect(verifyEd25519(s, key, payload)).toBe(true);
    expect(verifyEd25519(s, key, new Uint8Array(32))).toBe(false);
  });

  test("decodeSign1 requires tag 18", () => {
    const untagged = encodeSign1(signEs256k(protectedBytes, payload, sk)).subarray(1);
    expect(() => decodeSign1(untagged)).toThrow(expect.objectContaining({ code: "format" }));
  });
});
