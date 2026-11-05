import { currencyNumeric, toHex } from "@keelson/core";
import {
  BN254_FR_MODULUS,
  fieldFromAscii,
  KEELSON_MANDATE,
  poseidon2,
} from "@keelson/core/poseidon2";
import { type Mandate, parseMandate } from "./schema.ts";

const KEELSON_MERCHANT = fieldFromAscii("KEELSON_MERCHANT");
const DEPTH = 8;
const CHUNK = 31;

/** Merchants a tree holds: every slot of the depth-8 tree except the zero leaf at index 0. */
export const MERCHANT_TREE_CAPACITY: number = 2 ** DEPTH - 1;

const bytesToBigInt = (bytes: Uint8Array): bigint => BigInt(toHex(bytes));

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Reads the canonical unpadded base64url encoding (RFC 4648 section 5) of exactly `bytes` bytes
 * as a big-endian integer. Non-zero pad bits, padding and wrong lengths are rejected.
 */
function base64urlToBigInt(s: string, bytes: number): bigint {
  if (s.length !== Math.ceil((bytes * 8) / 6)) {
    throw new RangeError(`not ${bytes} bytes of base64url`);
  }
  let acc = 0n;
  for (const ch of s) {
    const v = B64URL.indexOf(ch);
    if (v < 0) throw new RangeError("not base64url");
    acc = (acc << 6n) | BigInt(v);
  }
  const pad = BigInt((s.length * 6) % 8);
  if (acc & ((1n << pad) - 1n)) throw new RangeError("non-canonical base64url");
  return acc >> pad;
}

/**
 * Maps a merchant id to a field: `poseidon2([KEELSON_MERCHANT, c_0, …, c_k])` where `c_i` are
 * the UTF-8 bytes in consecutive 31-byte chunks, each read big-endian. NUL is rejected so that
 * no chunk starts with a zero byte, which makes the chunk encoding injective, and lone
 * surrogates are rejected because UTF-8 would encode them all as U+FFFD.
 */
export async function merchantLeaf(merchantId: string): Promise<bigint> {
  if (merchantId.length === 0) throw new RangeError("empty merchant id");
  if (merchantId.includes("\0")) throw new RangeError("merchant id contains NUL");
  if (!merchantId.isWellFormed()) throw new RangeError("merchant id contains a lone surrogate");
  const bytes = new TextEncoder().encode(merchantId);
  const chunks: bigint[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    chunks.push(bytesToBigInt(bytes.subarray(i, i + CHUNK)));
  }
  return poseidon2([KEELSON_MERCHANT, ...chunks]);
}

/**
 * Indexed Merkle tree leaf, as in Aztec's nullifier tree: `nextIndex = 0` and `next = 0`
 * together mean the leaf holds the largest value.
 */
export interface LeafPreimage {
  value: bigint;
  next: bigint;
  nextIndex: number;
}

/**
 * Ordered merchant tree. `leaves` are the merchant fields in ascending order; leaf `i + 1`
 * of the tree holds `leaves[i]`, and leaf 0 holds the zero value.
 */
export interface MerchantTree {
  root: bigint;
  leaves: bigint[];
  layers: bigint[][];
}

export interface MembershipProof {
  leaf: LeafPreimage;
  path: bigint[];
  index: number;
}

export interface NonMembershipProof {
  low: LeafPreimage;
  path: bigint[];
  index: number;
}

const isEmpty = (p: LeafPreimage): boolean => p.value === 0n && p.next === 0n && p.nextIndex === 0;

/** `poseidon2([value, next, nextIndex])`, and 0 for the empty preimage (Aztec's convention). */
function leafHash(p: LeafPreimage): Promise<bigint> {
  return isEmpty(p) ? Promise.resolve(0n) : poseidon2([p.value, p.next, BigInt(p.nextIndex)]);
}

let zeroes: Promise<bigint[]> | undefined;

/** Roots of empty subtrees by height: `z_0 = 0`, `z_{h+1} = poseidon2([z_h, z_h])`. */
function zeroSubtrees(): Promise<bigint[]> {
  zeroes ??= (async () => {
    const z = [0n];
    for (let h = 0; h < DEPTH; h++) z.push(await poseidon2([z[h] as bigint, z[h] as bigint]));
    return z;
  })();
  return zeroes;
}

function preimageAt(leaves: readonly bigint[], index: number): LeafPreimage {
  if (index > leaves.length) return { value: 0n, next: 0n, nextIndex: 0 };
  const last = index === leaves.length;
  return {
    value: index === 0 ? 0n : (leaves[index - 1] as bigint),
    next: last ? 0n : (leaves[index] as bigint),
    nextIndex: last ? 0 : index + 1,
  };
}

/**
 * Builds the depth-8 ordered (indexed) Merkle tree of the given merchant ids, with inner nodes
 * `poseidon2([left, right])`. Leaf 0 is the zero leaf, so a non-membership proof is a single
 * low-leaf opening even below the smallest id. Throws on no ids, duplicates, or more than
 * {@link MERCHANT_TREE_CAPACITY}.
 */
export async function merchantTree(ids: readonly string[]): Promise<MerchantTree> {
  if (ids.length === 0) throw new RangeError("no merchants");
  if (ids.length > MERCHANT_TREE_CAPACITY) {
    throw new RangeError(`more than ${MERCHANT_TREE_CAPACITY} merchants`);
  }
  const values = await Promise.all(ids.map(merchantLeaf));
  const leaves = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (let i = 1; i < leaves.length; i++) {
    if (leaves[i] === leaves[i - 1]) throw new RangeError("duplicate merchant id");
  }
  const z = await zeroSubtrees();
  const width = 2 ** DEPTH;
  let layer = new Array<bigint>(width).fill(0n);
  for (let i = 0; i <= leaves.length; i++) layer[i] = await leafHash(preimageAt(leaves, i));
  const layers = [layer];
  for (let h = 0; h < DEPTH; h++) {
    const next: bigint[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const l = layer[i] as bigint;
      const r = layer[i + 1] as bigint;
      next.push(l === z[h] && r === z[h] ? (z[h + 1] as bigint) : await poseidon2([l, r]));
    }
    layers.push(next);
    layer = next;
  }
  return { root: layer[0] as bigint, leaves, layers };
}

function pathOf(tree: MerchantTree, index: number): bigint[] {
  return tree.layers.slice(0, DEPTH).map((layer, h) => layer[(index >> h) ^ 1] as bigint);
}

async function rootOf(leaf: LeafPreimage, index: number, path: readonly bigint[]): Promise<bigint> {
  let node = await leafHash(leaf);
  for (let h = 0; h < DEPTH; h++) {
    const sibling = path[h] as bigint;
    node = await poseidon2((index >> h) & 1 ? [sibling, node] : [node, sibling]);
  }
  return node;
}

async function opens(root: bigint, leaf: LeafPreimage, index: number, path: readonly bigint[]) {
  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < 2 ** DEPTH &&
    path.length === DEPTH &&
    (await rootOf(leaf, index, path)) === root
  );
}

/** Opens the leaf holding `id`. Throws if `id` is not in the tree. */
export async function merchantMembership(tree: MerchantTree, id: string): Promise<MembershipProof> {
  const v = await merchantLeaf(id);
  const i = tree.leaves.indexOf(v);
  if (i < 0) throw new RangeError("merchant is not in the tree");
  return { leaf: preimageAt(tree.leaves, i + 1), path: pathOf(tree, i + 1), index: i + 1 };
}

/**
 * Opens the low leaf of `id`: the leaf with the largest value below it, whose `next` is above
 * it or 0. Throws if `id` is in the tree.
 */
export async function merchantNonMembership(
  tree: MerchantTree,
  id: string,
): Promise<NonMembershipProof> {
  const v = await merchantLeaf(id);
  if (tree.leaves.includes(v)) throw new RangeError("merchant is in the tree");
  const index = tree.leaves.filter((x) => x < v).length;
  return { low: preimageAt(tree.leaves, index), path: pathOf(tree, index), index };
}

/** Checks that `proof` opens a leaf of `root` whose value is `id`'s field. */
export async function verifyMerchantMembership(
  root: bigint,
  id: string,
  proof: MembershipProof,
): Promise<boolean> {
  return (
    proof.leaf.value === (await merchantLeaf(id)) &&
    opens(root, proof.leaf, proof.index, proof.path)
  );
}

/**
 * Checks that `proof` opens a non-empty leaf of `root` with `low.value < id < low.next` (or no
 * next). The low leaf must not be the empty preimage: it hashes to 0 like every unused slot and
 * would otherwise pass as a low leaf for any id.
 */
export async function verifyMerchantNonMembership(
  root: bigint,
  id: string,
  proof: NonMembershipProof,
): Promise<boolean> {
  const v = await merchantLeaf(id);
  const { low } = proof;
  const last = low.next === 0n && low.nextIndex === 0;
  return (
    !isEmpty(low) &&
    low.value < v &&
    (last || v < low.next) &&
    opens(root, low, proof.index, proof.path)
  );
}

/**
 * Category bit table, version `v1`. Bit `i` of a category mask stands for `ids[i]`; entries are
 * only ever appended. Ids are Google Product Taxonomy ids (taxonomy version 2021-09-21): the 21
 * top-level categories in taxonomy order, then `gpt:187` (Apparel & Accessories > Shoes).
 */
export const CATEGORY_TABLE: { readonly version: "v1"; readonly ids: readonly string[] } = {
  version: "v1",
  ids: [
    "gpt:1", // Animals & Pet Supplies
    "gpt:166", // Apparel & Accessories
    "gpt:8", // Arts & Entertainment
    "gpt:537", // Baby & Toddler
    "gpt:111", // Business & Industrial
    "gpt:141", // Cameras & Optics
    "gpt:222", // Electronics
    "gpt:412", // Food, Beverages & Tobacco
    "gpt:436", // Furniture
    "gpt:632", // Hardware
    "gpt:469", // Health & Beauty
    "gpt:536", // Home & Garden
    "gpt:5181", // Luggage & Bags
    "gpt:772", // Mature
    "gpt:783", // Media
    "gpt:922", // Office Supplies
    "gpt:5605", // Religious & Ceremonial
    "gpt:2092", // Software
    "gpt:988", // Sporting Goods
    "gpt:1239", // Toys & Games
    "gpt:888", // Vehicles & Parts
    "gpt:187", // Apparel & Accessories > Shoes
  ],
};

const ALL_CATEGORIES = (1n << BigInt(CATEGORY_TABLE.ids.length)) - 1n;

/** Sets bit `i` for every category whose position in {@link CATEGORY_TABLE} is `i`. */
export function categoryMask(categories: readonly string[]): bigint {
  let mask = 0n;
  for (const c of categories) {
    const i = CATEGORY_TABLE.ids.indexOf(c);
    if (i < 0) throw new RangeError(`unknown category ${c}`);
    mask |= 1n << BigInt(i);
  }
  return mask;
}

/** The mandate's allowed categories minus `deny`; without a category constraint, every category. */
function mandateCategoryMask(m: Mandate): bigint {
  const c = m.checkout.constraints.find((x) => x.type === "keelson.category");
  if (c?.type !== "keelson.category") return ALL_CATEGORIES;
  return categoryMask(c.allow) & ~categoryMask(c.deny);
}

const LIMB = (1n << 128n) - 1n;

/**
 * `poseidon2([x_hi, x_lo, y_hi, y_lo])`: each 32-byte P-256 coordinate split into two 128-bit
 * big-endian limbs, which is injective and matches a circuit taking the key as `[u8; 32]` pairs.
 */
export async function userKeyHash(jwk: { x: string; y: string }): Promise<bigint> {
  const x = base64urlToBigInt(jwk.x, 32);
  const y = base64urlToBigInt(jwk.y, 32);
  return poseidon2([x >> 128n, x & LIMB, y >> 128n, y & LIMB]);
}

/**
 * `C_m = poseidon2([KEELSON_MANDATE, user_key_hash, max_amount, currency_num, category_mask,
 * merchant_root, expiry, operator_id, nonce, salt])`, with `nonce` and the 16-byte `salt` read
 * big-endian. The mandate is validated with {@link parseMandate} first.
 */
export async function mandateCommitment(input: Mandate, salt: Uint8Array): Promise<bigint> {
  if (salt.length !== 16) throw new RangeError("salt must be 16 bytes");
  const m = parseMandate(input);
  const range = m.payment.constraints.find((c) => c.type === "payment.amount_range");
  const merchants = m.checkout.constraints.find((c) => c.type === "checkout.allowed_merchants");
  if (range?.type !== "payment.amount_range" || merchants?.type !== "checkout.allowed_merchants") {
    throw new RangeError("mandate lacks amount_range or allowed_merchants");
  }
  const agentId = m.agent.operator.agent_id;
  const operatorId = /^(0|[1-9]\d*)$/.test(agentId) ? BigInt(agentId) : BN254_FR_MODULUS;
  if (operatorId >= BN254_FR_MODULUS) {
    throw new RangeError("operator id is not a field element");
  }
  const [userKey, tree] = await Promise.all([
    userKeyHash(m.user.cred.jwk),
    merchantTree(merchants.allowed.map((x) => x.id)),
  ]);
  return poseidon2([
    KEELSON_MANDATE,
    userKey,
    BigInt(range.max),
    BigInt(currencyNumeric(m.payment.currency)),
    mandateCategoryMask(m),
    tree.root,
    BigInt(m.exp),
    operatorId,
    base64urlToBigInt(m.nonce, 16),
    bytesToBigInt(salt),
  ]);
}
