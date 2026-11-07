import { readFileSync } from "node:fs";
import { DST, fromHex, sha256, toHex } from "@keelson/core";
import { describe, expect, test } from "vitest";
import {
  buildManifest,
  type Disclosure,
  disclose,
  ITEM_TYPES,
  inclusionPath,
  itemLeaf,
  MEDIA_TYPES,
  rootFromPath,
  type SealedItem,
  treeRoot,
  verifyDisclosure,
} from "../src/index.ts";

interface Vectors {
  commit: string;
  leafHashes: string[];
  roots: Record<string, string>;
  inclusion: {
    leafIndex: number;
    treeSize: number;
    root: string;
    leafHash: string;
    path: string[];
  }[];
}

const vectors: Vectors = JSON.parse(
  readFileSync(new URL("./vectors/rfc6962.json", import.meta.url), "utf8"),
);
const leaves = vectors.leafHashes.map(fromHex);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const encoder = new TextEncoder();
const salt = () => crypto.getRandomValues(new Uint8Array(32));

describe("RFC 6962 tree", () => {
  test("roots match the reference data for 1 to 8 leaves", () => {
    for (let n = 1; n <= 8; n++) {
      expect(hex(treeRoot(leaves.slice(0, n)))).toBe(vectors.roots[String(n)]);
    }
  });

  test("inclusion paths match the reference proofs", () => {
    expect(vectors.commit).toMatch(/^[0-9a-f]{40}$/);
    for (const v of vectors.inclusion) {
      const path = inclusionPath(leaves.slice(0, v.treeSize), v.leafIndex);
      expect(path.map(hex)).toEqual(v.path);
      expect(
        hex(rootFromPath(fromHex(v.leafHash), v.leafIndex, v.treeSize, path) ?? new Uint8Array()),
      ).toBe(v.root);
    }
  });

  test("every path of every size up to 8 leads to the reference root", () => {
    for (let n = 1; n <= 8; n++) {
      for (let m = 0; m < n; m++) {
        const path = inclusionPath(leaves.slice(0, n), m);
        const root = rootFromPath(leaves[m] as Uint8Array, m, n, path);
        expect(root && hex(root)).toBe(vectors.roots[String(n)]);
      }
    }
  });

  test("an empty tree is refused", () => {
    expect(() => treeRoot([])).toThrow();
  });
});

describe("item leaves", () => {
  test("the leaf is SHA-256 over the documented byte layout", () => {
    const s = new Uint8Array(32).fill(7);
    const contentHash = sha256(encoder.encode('{"a":1}'));
    const layout = new Uint8Array([
      0x00,
      ...encoder.encode(DST.evidenceItem),
      ...s,
      ...encoder.encode("api.product"),
      0x00,
      ...encoder.encode("application/json"),
      0x00,
      ...contentHash,
    ]);
    expect(
      hex(itemLeaf({ type: "api.product", mediaType: "application/json", contentHash, salt: s })),
    ).toBe(hex(sha256(layout)));
  });

  test("a salt that is not 32 bytes is refused", () => {
    expect(() =>
      itemLeaf({
        type: "api.product",
        mediaType: "application/json",
        contentHash: new Uint8Array(32),
        salt: new Uint8Array(16),
      }),
    ).toThrow();
  });
});

function twelveItems(salts?: Uint8Array[]): SealedItem[] {
  const publicTypes = ITEM_TYPES.slice(0, 9);
  const originals = ["api.cart", "dom.snapshot", "screenshot"] as const;
  const items: SealedItem[] = publicTypes.map((type, i) => ({
    type,
    mediaType: MEDIA_TYPES[type],
    bytes: encoder.encode(`${type} body`),
    salt: salts?.[i] ?? salt(),
  }));
  for (const [j, type] of originals.entries()) {
    items.push({
      type: `${type}.original`,
      mediaType: "application/octet-stream",
      bytes: encoder.encode(`${type} sealed`),
      salt: salts?.[9 + j] ?? salt(),
    });
  }
  return items;
}

describe("manifest", () => {
  test("lists type, media type and content hash, and no salts", () => {
    const items = twelveItems();
    const m = buildManifest(items);
    expect(m.v).toBe("keelson.manifest/1");
    expect(m.items).toHaveLength(12);
    expect(m.items[0]).toEqual({
      type: "api.product",
      media_type: "application/json",
      content_hash: toHex(sha256(items[0]?.bytes as Uint8Array)),
    });
    expect(JSON.stringify(m)).not.toContain("salt");
  });

  test("refuses an empty list, a duplicate type and a broken order", () => {
    const items = twelveItems();
    expect(() => buildManifest([])).toThrow();
    expect(() => buildManifest([items[0] as SealedItem, items[0] as SealedItem])).toThrow();
    expect(() => buildManifest([items[1] as SealedItem, items[0] as SealedItem])).toThrow();
    expect(() => buildManifest([items[9] as SealedItem, items[0] as SealedItem])).toThrow();
    expect(() =>
      buildManifest([{ ...(items[0] as SealedItem), type: "unknown" as never }]),
    ).toThrow();
  });

  test("the same items and salts give the same root; fresh salts change every leaf", () => {
    const salts = Array.from({ length: 12 }, salt);
    const a = buildManifest(twelveItems(salts));
    const b = buildManifest(twelveItems(salts));
    expect(a.root).toBe(b.root);

    const fresh = twelveItems();
    const c = buildManifest(fresh);
    expect(c.root).not.toBe(a.root);
    expect(c.items.map((i) => i.content_hash)).toEqual(a.items.map((i) => i.content_hash));
    const pinned = twelveItems(salts);
    for (const [i, item] of fresh.entries()) {
      const p = pinned[i] as SealedItem;
      const leaf = (x: SealedItem) =>
        hex(
          itemLeaf({
            type: x.type,
            mediaType: x.mediaType,
            contentHash: sha256(x.bytes),
            salt: x.salt,
          }),
        );
      expect(leaf(item)).not.toBe(leaf(p));
    }
  });
});

describe("disclosure", () => {
  const items = twelveItems();
  const root = buildManifest(items).root;

  test("an honest disclosure verifies for every index", () => {
    for (let i = 0; i < items.length; i++) {
      const d = disclose(items, i);
      expect(d.size).toBe(12);
      expect(verifyDisclosure(root, d)).toBe(true);
      expect(verifyDisclosure(root, d, (items[i] as SealedItem).bytes)).toBe(true);
    }
  });

  test("each tampering is refused", () => {
    const d = disclose(items, 3);
    const flip = (h: string) => `${h.slice(0, -1)}${h.endsWith("0") ? "1" : "0"}` as `0x${string}`;
    const cases: Disclosure[] = [
      { ...d, salt: flip(d.salt) },
      { ...d, type: "ax.tree" },
      { ...d, media_type: "text/plain" },
      { ...d, content_hash: flip(d.content_hash) },
      { ...d, path: disclose(items, 4).path },
      { ...d, index: 4 },
      { ...d, path: d.path.slice(1) },
    ];
    for (const bad of cases) expect(verifyDisclosure(root, bad)).toBe(false);
    expect(verifyDisclosure(root, d, encoder.encode("other bytes"))).toBe(false);
    expect(verifyDisclosure(buildManifest(twelveItems()).root, d)).toBe(false);
  });
});
