import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { receiptReference, segmentHashes, verifyAp2Chain, verifyAp2Receipt } from "../src/ap2.ts";

/** The AP2 conformance vectors (goodmeta/ap2-conformance), minted by AP2's reference SDK. */
const vectors = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../vendor/goodmeta/vectors/${name}.json`, import.meta.url), "utf8"),
  );
/** VECTORS.md: every time-dependent check runs at this instant. */
const CLOCK = 1780000000;

interface ChainVector {
  name: string;
  chain: string;
  kind?: "x5c";
  rootKey?: Record<string, unknown>;
  expectedAud: string;
  expectedNonce: string;
  expect: "valid" | "reject";
  hardening?: boolean;
  expectedPayloads?: Record<string, unknown>[];
}

const chains = (vectors("chain") as ChainVector[]).filter((v) => !v.hardening);

describe("chain (core)", () => {
  // Keelson's exports name their issuer by kid; the x5c trust path is not implemented.
  const byKid = chains.filter((v) => v.kind !== "x5c");
  test("covers the core kid-trust vectors", () => expect(byKid.length).toBe(17));
  test.each(byKid.map((v) => [v.name, v] as const))("%s", async (_, v) => {
    const run = verifyAp2Chain({
      chain: v.chain,
      rootKey: v.rootKey as JsonWebKey,
      currentTimeUnix: CLOCK,
      expectedAud: v.expectedAud,
      expectedNonce: v.expectedNonce,
    });
    if (v.expect === "valid") expect(await run).toEqual(v.expectedPayloads);
    else await expect(run).rejects.toThrow();
  });
});

describe("receipt-reference (core)", () => {
  const { receiptReferences } = vectors("linkage") as {
    receiptReferences: { name: string; chain: string; ap2Reference: string }[];
  };
  test.each(receiptReferences.map((v) => [v.name, v] as const))("%s", (_, v) => {
    expect(receiptReference(v.chain)).toBe(v.ap2Reference);
  });
});

describe("receipts (core)", () => {
  const all = vectors("receipts") as {
    name: string;
    kind: "payment" | "checkout";
    receiptJwt: string;
    issuerPublicKey: JsonWebKey;
    mandateChain: string;
    expect: "accept" | "reject";
  }[];
  test.each(all.map((v) => [v.name, v] as const))("%s", async (_, v) => {
    const run = verifyAp2Receipt(v);
    if (v.expect === "accept") await expect(run).resolves.toBeUndefined();
    else await expect(run).rejects.toThrow();
  });
});

describe("hash-pairs (core)", () => {
  const { rawSplitOnDoubleTilde, segments } = vectors("hash-pairs") as {
    rawSplitOnDoubleTilde: string[];
    segments: Record<string, unknown>[];
  };
  test("every segment's canonical form and hashes", () => {
    expect(segmentHashes(rawSplitOnDoubleTilde.join("~~"))).toEqual(segments);
  });
});
