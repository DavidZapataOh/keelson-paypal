import { readFileSync } from "node:fs";
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vitest";
import { LOG_ORIGINS, verifyCheckpointOfOrigin, verifyConsistency } from "../src/index.ts";

interface Vector {
  ok: boolean;
  proof: string[];
  root1: string;
  root2: string;
  size1: number;
  size2: number;
}

// Computed with transparency-dev/merkle; `sandboxConsistency` are proofs read from the
// tiles of log.keelson.finance/alibi/2026-1 at size 54.
const vectors = JSON.parse(
  readFileSync(new URL("../../../contracts/test/vectors/rfc6962.json", import.meta.url), "utf8"),
) as { consistency: Vector[]; sandboxConsistency: Vector[] };

const h = (x: string) => hexToBytes(x.slice(2));
const run = (v: Vector, proof = v.proof.map(h)) =>
  verifyConsistency(BigInt(v.size1), BigInt(v.size2), h(v.root1), h(v.root2), proof);

const checkpoint = readFileSync(
  new URL("./fixtures/checkpoints/alibi-2026-1-54.txt", import.meta.url),
  "utf8",
);

describe("RFC 9162 consistency proofs", () => {
  test("every conformance vector gives its expected result", () => {
    expect(vectors.consistency.length).toBeGreaterThan(4000);
    for (const v of vectors.consistency) expect(run(v), JSON.stringify(v)).toBe(v.ok);
  });

  test("proofs from the sandbox log reach its witnessed checkpoint", () => {
    const cp = verifyCheckpointOfOrigin(checkpoint, LOG_ORIGINS[421614] as string);
    expect(vectors.sandboxConsistency.length).toBeGreaterThan(0);
    for (const v of vectors.sandboxConsistency) {
      expect(BigInt(v.size2)).toBe(cp.size);
      expect(h(v.root2)).toEqual(cp.root);
      expect(run(v)).toBe(true);
      for (let i = 0; i < v.proof.length; i++) {
        const proof = v.proof.map(h);
        const node = proof[i] as Uint8Array;
        node[7] = (node[7] as number) ^ 1;
        expect(run(v, proof)).toBe(false);
      }
      expect(run(v, v.proof.map(h).slice(1))).toBe(false);
      expect(run(v, [...v.proof.map(h), h(v.root1)])).toBe(false);
    }
  });

  test("degenerate sizes are refused", () => {
    const v = vectors.sandboxConsistency[0] as Vector;
    const [r1, r2, proof] = [h(v.root1), h(v.root2), v.proof.map(h)];
    expect(verifyConsistency(0n, 54n, r1, r2, proof)).toBe(false);
    expect(verifyConsistency(54n, BigInt(v.size1), r2, r1, proof)).toBe(false);
    expect(verifyConsistency(54n, 54n, r2, r2, [])).toBe(true);
    expect(verifyConsistency(54n, 54n, r2, r2, [r2])).toBe(false);
    expect(verifyConsistency(BigInt(v.size1), 54n, r1, r2, [])).toBe(false);
    expect(verifyConsistency(BigInt(v.size1), 54n, r1, r2, [proof[0]?.slice(1) ?? r1])).toBe(false);
  });
});
