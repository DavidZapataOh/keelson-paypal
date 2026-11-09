import { readFileSync } from "node:fs";
import { hexToBytes } from "@noble/hashes/utils.js";
import { toBase64, toBase64url } from "../src/b64.ts";
import type { AlibiReceipt } from "../src/schema.ts";

// The first 54 entries of log.keelson.finance/alibi/2026-1 (its entry tile, fetched 2026-11-09),
// the witnessed checkpoint at that size, and inclusion proofs read from its hash tiles.
const tile = new Uint8Array(readFileSync(new URL("./log/entries-000.p-54", import.meta.url)));
const checkpoint = readFileSync(
  new URL("../../log/test/fixtures/checkpoints/alibi-2026-1-54.txt", import.meta.url),
  "utf8",
);
const { sandboxInclusion } = JSON.parse(
  readFileSync(new URL("../../../contracts/test/vectors/rfc6962.json", import.meta.url), "utf8"),
) as { sandboxInclusion: { index: number; leafHash: string; proof: string[] }[] };

function entries(bundle: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let o = 0; o < bundle.length; ) {
    const n = ((bundle[o] as number) << 8) | (bundle[o + 1] as number);
    out.push(bundle.subarray(o + 2, o + 2 + n));
    o += 2 + n;
  }
  return out;
}

export const leaves = entries(tile);
export const receipts: AlibiReceipt[] = sandboxInclusion.map((v) => {
  const leaf = leaves[v.index] as Uint8Array;
  const body = JSON.parse(new TextDecoder().decode(leaf).split("\n")[1] as string) as {
    alibi_id: string;
  };
  const hashes = v.proof.map((h) => `${toBase64(hexToBytes(h.slice(2)))}\n`).join("");
  return {
    alibi_id: body.alibi_id,
    leaf: toBase64(leaf),
    leaf_hash: toBase64url(hexToBytes(v.leafHash.slice(2))),
    tlog_proof: `c2sp.org/tlog-proof@v1\nindex ${v.index}\n${hashes}\n${checkpoint}`,
    timestamps: [],
  };
});
