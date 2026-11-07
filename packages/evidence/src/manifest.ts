import { fromHex, sha256, toHex } from "@keelson/core";
import { type Hex32, type ItemKind, itemLeaf, itemRank, type SealedItem } from "./items.ts";

export interface ManifestEntry {
  type: ItemKind;
  media_type: string;
  /** The salted item leaf. The unsalted content hash is only given in a disclosure. */
  leaf: Hex32;
}

/**
 * The public manifest: what each item is and its salted leaf, from which anyone can recompute
 * `root`. Content hashes and salts stay with the holder until an item is disclosed.
 */
export interface Manifest {
  v: "keelson.manifest/1";
  root: Hex32;
  items: ManifestEntry[];
}

/** One item opened to an arbiter, with its salt and RFC 9162 inclusion path. */
export interface Disclosure {
  index: number;
  type: ItemKind;
  media_type: string;
  content_hash: Hex32;
  salt: Hex32;
  path: Hex32[];
  size: number;
}

const HEX32 = /^0x[0-9a-f]{64}$/;

function node(left: Uint8Array, right: Uint8Array): Uint8Array {
  const input = new Uint8Array(65);
  input[0] = 0x01;
  input.set(left, 1);
  input.set(right, 33);
  return sha256(input);
}

/** The largest power of two strictly less than `n` (n > 1). */
function split(n: number): number {
  let k = 1;
  while (k << 1 < n) k <<= 1;
  return k;
}

/** RFC 6962 §2.1 Merkle Tree Hash over leaf hashes. An empty tree is not allowed here. */
export function treeRoot(leaves: readonly Uint8Array[]): Uint8Array {
  if (leaves.length === 0) throw new RangeError("a tree needs at least one leaf");
  if (leaves.length === 1) return leaves[0] as Uint8Array;
  const k = split(leaves.length);
  return node(treeRoot(leaves.slice(0, k)), treeRoot(leaves.slice(k)));
}

/** RFC 9162 §2.1.3.1 inclusion path of leaf `m`, ordered from the leaf up. */
export function inclusionPath(leaves: readonly Uint8Array[], m: number): Uint8Array[] {
  if (!Number.isInteger(m) || m < 0 || m >= leaves.length)
    throw new RangeError("index out of range");
  if (leaves.length === 1) return [];
  const k = split(leaves.length);
  return m < k
    ? [...inclusionPath(leaves.slice(0, k), m), treeRoot(leaves.slice(k))]
    : [...inclusionPath(leaves.slice(k), m - k), treeRoot(leaves.slice(0, k))];
}

/** RFC 9162 §2.1.3.2: the root an inclusion path leads to, or `null` if the path is malformed. */
export function rootFromPath(
  leaf: Uint8Array,
  index: number,
  size: number,
  path: readonly Uint8Array[],
): Uint8Array | null {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(size) || index < 0 || index >= size)
    return null;
  let fn = BigInt(index);
  let sn = BigInt(size - 1);
  let r = leaf;
  for (const p of path) {
    if (p.length !== 32 || sn === 0n) return null;
    if ((fn & 1n) === 1n || fn === sn) {
      r = node(p, r);
      while ((fn & 1n) === 0n && fn !== 0n) {
        fn >>= 1n;
        sn >>= 1n;
      }
    } else {
      r = node(r, p);
    }
    fn >>= 1n;
    sn >>= 1n;
  }
  return sn === 0n ? r : null;
}

function leafOf(item: SealedItem): Uint8Array {
  return itemLeaf({
    type: item.type,
    mediaType: item.mediaType,
    contentHash: sha256(item.bytes),
    salt: item.salt,
  });
}

function checkOrder(items: readonly SealedItem[]): void {
  if (items.length === 0) throw new RangeError("a manifest needs at least one item");
  const salts = new Set(items.map((i) => toHex(i.salt)));
  if (salts.size !== items.length) throw new TypeError("every item needs its own salt");
  let last = -1;
  for (const item of items) {
    const rank = itemRank(item.type);
    if (rank < 0) throw new TypeError(`unknown item type ${item.type}`);
    if (rank <= last) throw new TypeError(`item ${item.type} is duplicated or out of order`);
    last = rank;
  }
}

/** Builds the manifest and its `evidenceRoot` over the sealed items. */
export function buildManifest(items: readonly SealedItem[]): Manifest {
  checkOrder(items);
  const leaves = items.map(leafOf);
  return {
    v: "keelson.manifest/1",
    root: toHex(treeRoot(leaves)),
    items: items.map((item, k) => ({
      type: item.type,
      media_type: item.mediaType,
      leaf: toHex(leaves[k] as Uint8Array),
    })),
  };
}

/** Whether a public manifest's leaves build its root and its items are in manifest order. */
export function verifyManifest(m: Manifest): boolean {
  if (m.v !== "keelson.manifest/1" || !HEX32.test(m.root) || m.items.length === 0) return false;
  let last = -1;
  for (const item of m.items) {
    const rank = itemRank(item.type);
    if (rank <= last || !HEX32.test(item.leaf)) return false;
    last = rank;
  }
  return toHex(treeRoot(m.items.map((i) => fromHex(i.leaf)))) === m.root;
}

/** Opens one item: its salt and inclusion path, enough to check it against the root alone. */
export function disclose(items: readonly SealedItem[], index: number): Disclosure {
  checkOrder(items);
  const item = items[index];
  if (!item) throw new RangeError("index out of range");
  return {
    index,
    type: item.type,
    media_type: item.mediaType,
    content_hash: toHex(sha256(item.bytes)),
    salt: toHex(item.salt),
    path: inclusionPath(items.map(leafOf), index).map(toHex),
    size: items.length,
  };
}

/**
 * Checks a disclosure against an `evidenceRoot`. With `bytes`, also checks that they are the
 * disclosed item's content.
 */
export function verifyDisclosure(root: Hex32, d: Disclosure, bytes?: Uint8Array): boolean {
  if (!HEX32.test(root) || !HEX32.test(d.content_hash) || !HEX32.test(d.salt)) return false;
  if (!d.path.every((p) => HEX32.test(p)) || itemRank(d.type) < 0) return false;
  if (bytes && toHex(sha256(bytes)) !== d.content_hash) return false;
  let leaf: Uint8Array;
  try {
    leaf = itemLeaf({
      type: d.type,
      mediaType: d.media_type,
      contentHash: fromHex(d.content_hash),
      salt: fromHex(d.salt),
    });
  } catch {
    return false;
  }
  const got = rootFromPath(leaf, d.index, d.size, d.path.map(fromHex));
  return got !== null && toHex(got) === root;
}
