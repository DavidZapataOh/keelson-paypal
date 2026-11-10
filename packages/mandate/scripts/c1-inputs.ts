/**
 * The inputs of the C1 `mandate_predicate` circuit for an $85 cart of `m`'s first merchant and
 * category, an hour after it was issued, under `salt`.
 */
import { currencyNumeric } from "@keelson/core";
import {
  categoryMask,
  mandateCommitment,
  merchantLeaf,
  merchantMembership,
  merchantTree,
  userKeyHash,
} from "../src/commitment.ts";
import { CATEGORY_TABLE, type Mandate } from "../src/schema.ts";

const hex = (x: bigint) => `0x${x.toString(16).padStart(64, "0")}`;
const be = (bytes: Uint8Array) => BigInt(`0x${Buffer.from(bytes).toString("hex")}`);

export async function c1Inputs(m: Mandate, salt: Uint8Array) {
  const range = m.payment.constraints.find((c) => c.type === "payment.amount_range");
  const merchants = m.checkout.constraints.find((c) => c.type === "checkout.allowed_merchants");
  const category = m.checkout.constraints.find((c) => c.type === "keelson.category");
  if (
    range?.type !== "payment.amount_range" ||
    merchants?.type !== "checkout.allowed_merchants" ||
    category?.type !== "keelson.category"
  ) {
    throw new Error("the mandate lacks a C1 constraint");
  }
  const merchantId = merchants.allowed[0]?.id as string;
  const tree = await merchantTree(merchants.allowed.map((x) => x.id));
  const opening = await merchantMembership(tree, merchantId);
  const cartCategory = category.allow[0] as string;
  const nonce = Buffer.from(m.nonce, "base64url");
  return {
    c_m: hex(await mandateCommitment(m, salt)),
    amount: "8500",
    currency: String(currencyNumeric(m.payment.currency)),
    category: String(CATEGORY_TABLE.ids.indexOf(cartCategory)),
    merchant_id: hex(await merchantLeaf(merchantId)),
    now: String(m.iat + 3600),
    cart_hash: hex(0x2a5f1c0e9b7d43a18e6c05f2d4b3a1908f7e6d5c4b3a29180f1e2d3c4b5a6978n),
    operator_id: m.agent.operator.agent_id,
    user_key_hash: hex(await userKeyHash(m.user.cred.jwk)),
    max_amount: String(range.max),
    category_mask: String(categoryMask(category.allow) & ~categoryMask(category.deny)),
    merchant_root: hex(tree.root),
    expiry: String(m.exp),
    nonce: hex(be(nonce)),
    salt: hex(be(salt)),
    merchant: {
      next: hex(opening.leaf.next),
      next_index: String(opening.leaf.nextIndex),
      index: String(opening.index),
      path: opening.path.map(hex),
    },
  };
}

/** C1's `Prover.toml` for {@link c1Inputs}. */
export function c1Toml(inputs: Awaited<ReturnType<typeof c1Inputs>>): string {
  const toml = (key: string, v: unknown): string =>
    Array.isArray(v) ? `${key} = [${v.map((x) => `"${x}"`).join(", ")}]` : `${key} = "${v}"`;
  const { merchant, ...flat } = inputs;
  return `${[
    ...Object.entries(flat).map(([k, v]) => toml(k, v)),
    "",
    "[merchant]",
    ...Object.entries(merchant).map(([k, v]) => toml(k, v)),
  ].join("\n")}\n`;
}
