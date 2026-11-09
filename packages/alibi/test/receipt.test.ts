import { readFileSync } from "node:fs";
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vitest";
import { toBase64, toBase64url } from "../src/b64.ts";
import { leafHashOf } from "../src/codec.ts";
import type { AlibiReceipt } from "../src/schema.ts";
import { verifyAlibi } from "../src/verify/index.ts";

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

const leaves = entries(tile);
const receipts: AlibiReceipt[] = sandboxInclusion.map((v) => {
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

describe("receipts of real log leaves", () => {
  test("the tile holds the 54 leaves the checkpoint commits to", () => {
    expect(leaves).toHaveLength(54);
    expect(receipts.length).toBeGreaterThan(0);
  });

  test.each(receipts.map((r) => [r.alibi_id, r] as const))(
    "%s: included, witnessed, nothing else disclosed",
    async (_, r) => {
      expect(toBase64url(leafHashOf(r))).toBe(r.leaf_hash);
      const report = await verifyAlibi(r, { now: new Date("2026-11-09T07:00:00Z") });
      const status = Object.fromEntries(report.checks.map((c) => [c.id, c.status]));
      expect(status).toEqual({
        "bundle.format": "pass",
        "leaf.view": "pass",
        "tee.countersign": "undisclosed",
        "log.policy": "undisclosed",
        "log.inclusion": "pass",
        "log.witnesses": "pass",
        "anchor.consistency": "pending",
        timestamps: "pending",
        "zk.c1": "absent",
        "evidence.manifest": "undisclosed",
        "paypal.ids": "undisclosed",
      });
      expect(report.verdict).toBe("incomplete");
    },
  );

  const r = receipts[0] as AlibiReceipt;
  test("a leaf of another alibi, a proof hash or a missing cosignature fails its check", async () => {
    const other = receipts[1] as AlibiReceipt;
    const swapped = await verifyAlibi({ ...r, leaf: other.leaf, leaf_hash: other.leaf_hash });
    expect(swapped.checks.find((c) => c.id === "leaf.view")?.status).toBe("fail");

    const lines = r.tlog_proof.split("\n");
    lines[2] = toBase64(new Uint8Array(32));
    const bad = await verifyAlibi({ ...r, tlog_proof: lines.join("\n") });
    expect(bad.checks.find((c) => c.id === "log.inclusion")).toMatchObject({
      status: "fail",
      reason: "not included",
      reads: ["/tlog_proof", "/leaf"],
    });

    const cosigs = r.tlog_proof.split("\n").filter((l) => l.startsWith("— witness-"));
    const one = cosigs.slice(1).reduce((p, l) => p.replace(`${l}\n`, ""), r.tlog_proof);
    const unwitnessed = await verifyAlibi({ ...r, tlog_proof: one });
    expect(unwitnessed.checks.find((c) => c.id === "log.witnesses")).toMatchObject({
      status: "fail",
      reason: "1 of 2",
    });
    expect(unwitnessed.verdict).toBe("failed");
  });
});
