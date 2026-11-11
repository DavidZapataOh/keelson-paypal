import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Tag } from "cbor2";
import { describe, expect, test } from "vitest";
import { decodeStrict, encode } from "../src/cbor.ts";
import {
  buildReceipt,
  leafHash,
  receiptProtected,
  rootFromInclusion,
  ScittReceiptError,
  verifyReceipt,
} from "../src/receipt.ts";
import { sigStructure } from "../src/sign1.ts";
import { signEd25519 } from "../src/testing.ts";
import { hasCddl, validateCddl } from "./cddl.ts";

const vectors = new URL("./vectors/merkle/", import.meta.url);
const b64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));

describe("RFC 9162 inclusion, transparency-dev/merkle vectors", () => {
  const files = readdirSync(vectors, { recursive: true, encoding: "utf8" }).filter((f) =>
    f.endsWith(".json"),
  );
  test.each(files)("%s", (file) => {
    const v = JSON.parse(readFileSync(new URL(file, vectors), "utf8"));
    let root: Uint8Array | null = null;
    try {
      root = rootFromInclusion(
        b64(v.leafHash),
        BigInt(v.leafIdx),
        BigInt(v.treeSize),
        (v.proof ?? []).map(b64),
      );
    } catch {
      root = null;
    }
    const ok = root !== null && bytesToHex(root) === bytesToHex(b64(v.root));
    expect(ok).toBe(!v.wantErr);
  });
});

/** A 7-leaf tree, its root and every inclusion path, computed independently of the verifier. */
function tree(entries: Uint8Array[]) {
  const node = (l: Uint8Array, r: Uint8Array) => sha256(Uint8Array.of(1, ...l, ...r));
  const mth = (hs: Uint8Array[]): Uint8Array => {
    if (hs.length === 1) return hs[0] as Uint8Array;
    let k = 1;
    while (k * 2 < hs.length) k *= 2;
    return node(mth(hs.slice(0, k)), mth(hs.slice(k)));
  };
  const path = (m: number, hs: Uint8Array[]): Uint8Array[] => {
    if (hs.length === 1) return [];
    let k = 1;
    while (k * 2 < hs.length) k *= 2;
    return m < k
      ? [...path(m, hs.slice(0, k)), mth(hs.slice(k))]
      : [...path(m - k, hs.slice(k)), mth(hs.slice(0, k))];
  };
  const hashes = entries.map(leafHash);
  return { root: mth(hashes), path: (i: number) => path(i, hashes) };
}

const ORIGIN = "log.keelson.finance/alibi/2026-1";
const secret = sha256(new TextEncoder().encode("keelson receipt test key"));
const publicKey = signEd25519.publicKey(secret);
const kid = sha256(publicKey);
const keys = new Map([[bytesToHex(kid), publicKey]]);
const entries = Array.from({ length: 7 }, (_, i) => new TextEncoder().encode(`entry ${i}`));
const t = tree(entries);

function receiptFor(index: number, size = 7, path = t.path(index), root = t.root) {
  const prot = receiptProtected(kid, ORIGIN);
  const signature = signEd25519(prot, root, secret, { detached: true }).signature;
  return buildReceipt(prot, signature, BigInt(size), BigInt(index), path);
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof ScittReceiptError ? err.code : `not a receipt error: ${err}`;
  }
  return "no error";
};

describe("RFC 9942 receipts", () => {
  test("the protected header is {1: -19, 4: kid, 15: {1: iss, 2: origin}, 395: 1}", () => {
    const prot = receiptProtected(kid, ORIGIN);
    expect(bytesToHex(prot.subarray(0, 4))).toBe("a4013204");
    const map = decodeStrict(prot) as Map<number, unknown>;
    expect([...map.keys()]).toEqual([1, 4, 15, 395]);
    expect(map.get(395)).toBe(1);
    expect(map.get(15)).toEqual(
      new Map<number, string>([
        [1, "https://log.keelson.finance"],
        [2, ORIGIN],
      ]),
    );
  });

  test.each([0, 1, 2, 3, 4, 5, 6])("a receipt verifies for leaf %i", (i) => {
    const out = verifyReceipt(receiptFor(i), entries[i] as Uint8Array, keys);
    expect(out.treeSize).toBe(7n);
    expect(out.leafIndex).toBe(BigInt(i));
    expect(out.root).toEqual(t.root);
    expect(out.kid).toBe(bytesToHex(kid));
  });

  test("refuses leaf_index >= tree_size", () => {
    expect(
      code(() => verifyReceipt(receiptFor(7, 7, t.path(6)), entries[6] as Uint8Array, keys)),
    ).toBe("index");
  });

  test("refuses a VDS other than RFC9162_SHA256", () => {
    const prot = encode(
      new Map<number, unknown>([
        [1, -19],
        [4, kid],
        [395, 2],
      ]),
    );
    const signature = signEd25519(prot, t.root, secret, { detached: true }).signature;
    const r = buildReceipt(prot, signature, 7n, 0n, t.path(0));
    expect(code(() => verifyReceipt(r, entries[0] as Uint8Array, keys))).toBe("vds");
  });

  test("refuses an unknown kid", () => {
    expect(code(() => verifyReceipt(receiptFor(0), entries[0] as Uint8Array, new Map()))).toBe(
      "kid",
    );
  });

  test("refuses a changed path", () => {
    const path = t.path(3).map((h) => h.slice());
    const first = path[0] as Uint8Array;
    first[0] = (first[0] as number) ^ 1;
    expect(code(() => verifyReceipt(receiptFor(3, 7, path), entries[3] as Uint8Array, keys))).toBe(
      "signature",
    );
  });

  test("refuses another entry", () => {
    expect(code(() => verifyReceipt(receiptFor(3), entries[4] as Uint8Array, keys))).toBe(
      "signature",
    );
  });

  test("refuses an attached payload", () => {
    const prot = receiptProtected(kid, ORIGIN);
    const signature = signEd25519(prot, t.root, secret, { detached: true }).signature;
    const proof = encode([7n, 0n, t.path(0)]);
    const attached = encode(
      new Tag(18, [prot, new Map([[396, new Map([[-1, [proof]]])]]), t.root, signature]),
    );
    expect(code(() => verifyReceipt(attached, entries[0] as Uint8Array, keys))).toBe("format");
  });

  test("refuses more than one inclusion proof", () => {
    const prot = receiptProtected(kid, ORIGIN);
    const signature = signEd25519(prot, t.root, secret, { detached: true }).signature;
    const proof = encode([7n, 0n, t.path(0)]);
    const two = encode(
      new Tag(18, [prot, new Map([[396, new Map([[-1, [proof, proof]]])]]), null, signature]),
    );
    expect(code(() => verifyReceipt(two, entries[0] as Uint8Array, keys))).toBe("format");
  });

  test("the receipt signs the root through a standard Sig_structure", () => {
    const prot = receiptProtected(kid, ORIGIN);
    const tbs = sigStructure(prot, t.root);
    expect(bytesToHex(tbs.subarray(0, 12))).toBe("846a5369676e617475726531");
  });

  test("the cross-language vector file is what this code produces", () => {
    const file = new URL("../../../internal/scitt/testdata/receipt.json", import.meta.url);
    const v = {
      origin: ORIGIN,
      secret_key_hex: bytesToHex(secret),
      public_key_hex: bytesToHex(publicKey),
      kid_hex: bytesToHex(kid),
      entries_hex: entries.map(bytesToHex),
      root_hex: bytesToHex(t.root),
      protected_hex: bytesToHex(receiptProtected(kid, ORIGIN)),
      receipts_hex: entries.map((_, i) => bytesToHex(receiptFor(i))),
    };
    if (process.env.KEELSON_WRITE_VECTORS === "1") {
      writeFileSync(file, `${JSON.stringify(v, null, 2)}\n`);
    }
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(v);
  });

  test.skipIf(!hasCddl())("the receipt validates against the RFC 9942 CDDL", () => {
    expect(validateCddl("rfc9942.cddl", "Receipt_For_Inclusion", receiptFor(2))).toBe(true);
  });
});
