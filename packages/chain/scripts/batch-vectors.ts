// Writes contracts/test/vectors/coverage-batch.json: a batch of 100 coverages of the demo agent,
// built from the live WebAuthn coverage's fields with distinct ids, its Merkle root, and the proof
// of entry 37. The contract tests set the anchored checkpoint from the fork.
import { readFileSync, writeFileSync } from "node:fs";
import { encodeAbiParameters, type Hex, keccak256, stringToHex } from "viem";
import { type Coverage, coverageBatch } from "../src/coverage.ts";

const contracts = new URL("../../../contracts/", import.meta.url);
const read = (path: string) => JSON.parse(readFileSync(new URL(path, contracts), "utf8"));
const registry = read("deployments/421614.json");
const live = read("test/vectors/coverage-2of2-webauthn.json") as {
  countersign: { requestId: Hex; mandateHash: Hex; issuedAt: string };
  userKeyHash: Hex;
};

const COUNT = 100;
const AMOUNT = 500_000n;
const PROVEN = 37;

const coverages: Coverage[] = Array.from({ length: COUNT }, (_, i) => {
  const coverageId = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }],
      [live.countersign.requestId, BigInt(i)],
    ),
  );
  return {
    coverageId,
    agentId: BigInt(registry.demo.agentId),
    merchant: registry.demo.merchant,
    amount: AMOUNT,
    premium: AMOUNT / 100n,
    expiresAt: Number(live.countersign.issuedAt) + registry.params.disputeWindow,
    mandateHash: live.countersign.mandateHash,
    amberCommitment: keccak256(stringToHex(`amber/${coverageId}`)),
    userKeyHash: live.userKeyHash,
  };
});
const { batch, proofs } = coverageBatch(
  coverages,
  { root: `0x${"00".repeat(32)}`, treeSize: 0n },
  (AMOUNT * BigInt(COUNT)) / 100n,
);
const proven = coverages[PROVEN] as Coverage;
const str = (v: unknown) => (typeof v === "bigint" ? v.toString() : v);
writeFileSync(
  new URL("test/vectors/coverage-batch.json", contracts),
  `${JSON.stringify(
    {
      count: COUNT,
      batch: Object.fromEntries(Object.entries(batch).map(([k, v]) => [k, str(v)])),
      proven: {
        index: PROVEN,
        coverage: Object.fromEntries(Object.entries(proven).map(([k, v]) => [k, str(v)])),
        proof: proofs.get(proven.coverageId),
      },
    },
    null,
    2,
  )}\n`,
);
console.log(`wrote a batch of ${COUNT} coverages, root ${batch.root}`);
