import { toBase64url } from "./b64.ts";
import { leafHashOf } from "./codec.ts";
import type { AlibiBundle } from "./schema.ts";

export const VERIFY_ORIGIN = "https://verify.keelson.finance";

/**
 * The canonical verify URL: `/a/<alibi_id>#<b64url(leaf_hash)>.<anchoredSize>.<chainId>`, with
 * `anchoredSize` 0 until the bundle carries an anchor.
 */
export function verifyUrl(b: AlibiBundle): string {
  const size = b.anchor?.anchored_size ?? "0";
  const chainId = b.anchor?.chain_id ?? b.tee.domain.chain_id;
  return `${VERIFY_ORIGIN}/a/${b.alibi_id}#${toBase64url(leafHashOf(b))}.${size}.${chainId}`;
}
