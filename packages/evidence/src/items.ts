import { DST, sha256 } from "@keelson/core";

/** The public item types, in manifest order. An item that does not apply is omitted. */
export const ITEM_TYPES = [
  "api.product",
  "api.cart",
  "llm.observation",
  "dom.snapshot",
  "ax.tree",
  "hidden.text",
  "screenshot",
  "mhtml",
  "har",
  "channel3.observation",
] as const;

export type ItemType = (typeof ITEM_TYPES)[number];

/** A public item, or the age-encrypted unredacted bytes of one. */
export type ItemKind = ItemType | `${ItemType}.original`;

export const MEDIA_TYPES: Readonly<Record<ItemType, string>> = Object.freeze({
  "api.product": "application/json",
  "api.cart": "application/json",
  "llm.observation": "text/plain; charset=utf-8",
  "dom.snapshot": "application/vnd.keelson.dom.v1+json",
  "ax.tree": "application/json",
  "hidden.text": "application/json",
  screenshot: "image/png",
  mhtml: "multipart/related",
  har: "application/json",
  "channel3.observation": "application/json",
});

export const ORIGINAL_MEDIA_TYPE = "application/octet-stream";

export type Hex32 = `0x${string}`;

export interface SealedItem {
  type: ItemKind;
  mediaType: string;
  bytes: Uint8Array;
  salt: Uint8Array;
}

/**
 * The position of a kind in the manifest order: public items first, then the originals in the
 * same order. Returns -1 for an unknown kind.
 */
export function itemRank(type: string): number {
  const original = type.endsWith(".original");
  const base = original ? type.slice(0, -".original".length) : type;
  const i = (ITEM_TYPES as readonly string[]).indexOf(base);
  if (i < 0) return -1;
  return original ? ITEM_TYPES.length + i : i;
}

const encoder = new TextEncoder();
const dst = encoder.encode(DST.evidenceItem);

function ascii(value: string, what: string): Uint8Array {
  if (!/^[\x20-\x7e]+$/.test(value))
    throw new TypeError(`${what} must be non-empty printable ASCII`);
  return encoder.encode(value);
}

/**
 * The tree leaf of one item:
 * `SHA-256(0x00 ‖ "keelson/evidence-item/v1" ‖ salt[32] ‖ type ‖ 0x00 ‖ media_type ‖ 0x00 ‖ content_hash[32])`.
 * The NUL terminators make the encoding injective.
 */
export function itemLeaf(item: {
  type: ItemKind;
  mediaType: string;
  contentHash: Uint8Array;
  salt: Uint8Array;
}): Uint8Array {
  if (item.salt.length !== 32) throw new TypeError("salt must be 32 bytes");
  if (item.contentHash.length !== 32) throw new TypeError("content hash must be 32 bytes");
  const type = ascii(item.type, "type");
  const media = ascii(item.mediaType, "media type");
  const out = new Uint8Array(1 + dst.length + 32 + type.length + 1 + media.length + 1 + 32);
  let o = 1;
  out.set(dst, o);
  o += dst.length;
  out.set(item.salt, o);
  o += 32;
  out.set(type, o);
  o += type.length + 1;
  out.set(media, o);
  o += media.length + 1;
  out.set(item.contentHash, o);
  return sha256(out);
}
