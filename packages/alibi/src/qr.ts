import { parseStatementLeaf } from "@keelson/log";
import { toBase64url } from "./b64.ts";
import { leafHashOf, registeredOf } from "./codec.ts";
import type { AlibiBundle, AlibiBundleV2 } from "./schema.ts";

export const VERIFY_ORIGIN = "https://verify.keelson.finance";

/** The chain a v2 statement's countersign names. */
function statementChain(b: AlibiBundleV2): number {
  const parsed = parseStatementLeaf(registeredOf(b));
  if (parsed.kind !== "purchase")
    throw new TypeError("an Alibi's statement is a purchase statement");
  return parsed.claims.chainId;
}

/**
 * The canonical verify URL: `/a/<alibi_id>#<b64url(leaf_hash)>.<anchoredSize>.<chainId>`, with
 * `anchoredSize` 0 until the bundle carries an anchor.
 */
export function verifyUrl(b: AlibiBundle | AlibiBundleV2): string {
  const size = b.anchor?.anchored_size ?? "0";
  const chainId =
    b.anchor?.chain_id ?? ("statement" in b ? statementChain(b) : b.tee.domain.chain_id);
  return `${VERIFY_ORIGIN}/a/${b.alibi_id}#${toBase64url(leafHashOf(b))}.${size}.${chainId}`;
}
