import { KEELSON_TYPES } from "@keelson/core/eip712";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { type Hex, hashStruct, keccak256, stringToHex } from "viem";
import { describe, expect, test } from "vitest";
import batchVector from "../../../contracts/test/vectors/coverage-batch.json" with { type: "json" };
import { type Coverage, coverageBatch } from "../src/coverage.ts";

const coverage = (i: number, agentId = 351n): Coverage => ({
  coverageId: keccak256(stringToHex(`coverage/${i}`)),
  agentId,
  merchant: "0x467D2beBb479D9B80Ab1c461243E05A2b82387d8",
  amount: BigInt(i + 1) * 1_000_000n,
  premium: 10_000n,
  expiresAt: 1_800_000_000 + i,
  mandateHash: keccak256(stringToHex(`mandate/${i}`)),
  amberCommitment: keccak256(stringToHex(`amber/${i}`)),
  userKeyHash: keccak256(stringToHex(`user/${i}`)),
});
const checkpoint = { root: keccak256(stringToHex("checkpoint")), treeSize: 54n };

describe("coverageBatch", () => {
  test("roots the coverages' struct hashes and proves each one", () => {
    const coverages = Array.from({ length: 100 }, (_, i) => coverage(i));
    const { batch, proofs } = coverageBatch(coverages, checkpoint, 5n);
    expect(batch.total).toBe(5050n * 1_000_000n);
    expect(batch.expiresAt).toBe(1_800_000_099);
    expect([batch.checkpointRoot, batch.treeSize, batch.premium]).toEqual([
      checkpoint.root,
      54n,
      5n,
    ]);
    for (const c of coverages) {
      const leaf = hashStruct({ data: c, primaryType: "Coverage", types: KEELSON_TYPES });
      expect(
        StandardMerkleTree.verify(
          batch.root,
          ["bytes32"],
          [leaf],
          proofs.get(c.coverageId) as Hex[],
        ),
      ).toBe(true);
    }
  });

  test("refuses an empty batch and one spanning agents", () => {
    expect(() => coverageBatch([], checkpoint, 0n)).toThrow(RangeError);
    expect(() => coverageBatch([coverage(0), coverage(1, 352n)], checkpoint, 0n)).toThrow(
      RangeError,
    );
  });

  test("the contract vector's proof checks against its root", () => {
    const c = Object.fromEntries(
      Object.entries(batchVector.proven.coverage).map(([k, v]) => [
        k,
        k === "expiresAt" ? Number(v) : /^\d+$/.test(String(v)) ? BigInt(v) : v,
      ]),
    ) as unknown as Coverage;
    const leaf = hashStruct({ data: c, primaryType: "Coverage", types: KEELSON_TYPES });
    expect(
      StandardMerkleTree.verify(
        batchVector.batch.root,
        ["bytes32"],
        [leaf],
        batchVector.proven.proof,
      ),
    ).toBe(true);
  });
});
