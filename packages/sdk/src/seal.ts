import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import canonicalize from "canonicalize";

/** The kinds of evidence this SDK seals, in manifest order. */
const ITEM_TYPES = ["api.product", "api.cart", "llm.observation"] as const;
type ItemType = (typeof ITEM_TYPES)[number];

const MEDIA_TYPES: Readonly<Record<ItemType, string>> = Object.freeze({
  "api.product": "application/json",
  "api.cart": "application/json",
  "llm.observation": "text/plain; charset=utf-8",
});

export interface SealedItem {
  type: ItemType;
  mediaType: string;
  bytes: Uint8Array;
  salt: Uint8Array;
}

/** What the agent saw when it chose the cart. */
export interface EvidenceSources {
  /** The store's own answer for the product (one), or the products (several). */
  product?: unknown;
  /** The store's own answer for the cart. */
  cart?: unknown;
  /** What the agent read that led to the cart, verbatim. No personal data. */
  observation: string;
}

export interface Manifest {
  v: "keelson.manifest/1";
  root: `0x${string}`;
  items: { type: ItemType; media_type: string; leaf: `0x${string}` }[];
}

const encoder = new TextEncoder();
const DST = encoder.encode("keelson/evidence-item/v1");
const hex = (b: Uint8Array): `0x${string}` => `0x${bytesToHex(b)}`;

/** UTF-8 RFC 8785 JSON. */
export function canonicalBytes(value: unknown): Uint8Array {
  const out = canonicalize(value);
  if (out === undefined || !out.isWellFormed()) throw new TypeError("value is not canonicalizable");
  return encoder.encode(out);
}

/** The items to seal from what the agent saw, each with its own 32-byte salt. */
export function sealedItems(sources: EvidenceSources, salts: Uint8Array[] = []): SealedItem[] {
  if (!sources.observation) throw new TypeError("an observation is required");
  const salt = (i: number) => salts[i] ?? crypto.getRandomValues(new Uint8Array(32));
  const items: Omit<SealedItem, "salt">[] = [];
  if (sources.product !== undefined) {
    items.push({
      type: "api.product",
      mediaType: MEDIA_TYPES["api.product"],
      bytes: canonicalBytes(sources.product),
    });
  }
  if (sources.cart !== undefined) {
    items.push({
      type: "api.cart",
      mediaType: MEDIA_TYPES["api.cart"],
      bytes: canonicalBytes(sources.cart),
    });
  }
  items.push({
    type: "llm.observation",
    mediaType: MEDIA_TYPES["llm.observation"],
    bytes: encoder.encode(sources.observation),
  });
  return items.map((item, i) => ({ ...item, salt: salt(i) }));
}

/** `SHA-256(0x00 ‖ dst ‖ salt ‖ type ‖ 0x00 ‖ media_type ‖ 0x00 ‖ SHA-256(bytes))`. */
function leaf(item: SealedItem): Uint8Array {
  const type = encoder.encode(item.type);
  const media = encoder.encode(item.mediaType);
  const out = new Uint8Array(1 + DST.length + 32 + type.length + 1 + media.length + 1 + 32);
  let o = 1;
  out.set(DST, o);
  o += DST.length;
  out.set(item.salt, o);
  o += 32;
  out.set(type, o);
  o += type.length + 1;
  out.set(media, o);
  o += media.length + 1;
  out.set(sha256(item.bytes), o);
  return sha256(out);
}

/** RFC 6962 §2.1 Merkle Tree Hash. */
function root(leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 1) return leaves[0] as Uint8Array;
  let k = 1;
  while (k << 1 < leaves.length) k <<= 1;
  const node = new Uint8Array(65);
  node[0] = 0x01;
  node.set(root(leaves.slice(0, k)), 1);
  node.set(root(leaves.slice(k)), 33);
  return sha256(node);
}

/** The public manifest of the sealed items and its `evidenceRoot`. */
export function manifestOf(items: SealedItem[]): Manifest {
  const leaves = items.map(leaf);
  return {
    v: "keelson.manifest/1",
    root: hex(root(leaves)),
    items: items.map((item, i) => ({
      type: item.type,
      media_type: item.mediaType,
      leaf: hex(leaves[i] as Uint8Array),
    })),
  };
}
