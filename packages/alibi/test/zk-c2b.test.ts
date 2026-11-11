import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { keccak256, stringToHex } from "viem";
import { describe, expect, test } from "vitest";
import { c2bStatement, verifyC2b } from "../src/verify/zk.ts";

type Vector = { proof: `0x${string}`; publicInputs: `0x${string}`[] };

const FIELDS = { size: 1, color: 2, unitPrice: 3, returnsFree: 4 } as const;

const vector = (field: keyof typeof FIELDS): Vector =>
  JSON.parse(
    readFileSync(
      new URL(`../../../contracts/test/vectors/c2b-${field}.json`, import.meta.url),
      "utf8",
    ),
  ) as Vector;

/** The demo store's session the vectors prove from, as `packages/core/scripts/c2b-vectors.ts` writes it. */
const url = new URL("https://store.keelson.finance/api/products/tempo-3/variants/RF-TMP3-11");
const range =
  '{"sku":"RF-TMP3-11","size":"11","color":"blue","unit_minor":12900,"returns_free":true}';
const blinder = Buffer.from(Array.from({ length: 16 }, (_, i) => 0x10 + i));
const fact = {
  hostHash: keccak256(stringToHex(url.hostname)),
  urlPathHash: keccak256(stringToHex(url.pathname)),
  rangeCommitment: `0x${createHash("sha256").update(range).update(blinder).digest("hex")}`,
};

describe("C2b", () => {
  test.each(Object.entries(FIELDS))("the court's statement of a %s conviction", (field, id) => {
    const v = vector(field as keyof typeof FIELDS);
    expect(c2bStatement(fact, v.publicInputs[2] as string, id)).toEqual(v.publicInputs);
  });

  test("a proof verifies against the pinned key", async () => {
    const v = vector("color");
    expect(await verifyC2b(v.proof, v.publicInputs)).toBe(true);
  }, 60_000);

  test("a proof of another field does not", async () => {
    const v = vector("color");
    const inputs = [...v.publicInputs.slice(0, 4), c2bStatement(fact, "0x0", 1)[4] as string];
    expect(await verifyC2b(v.proof, inputs)).toBe(false);
  }, 60_000);

  test("a proof of another page does not", async () => {
    const v = vector("size");
    const other = c2bStatement(
      { ...fact, urlPathHash: keccak256(stringToHex("/api/products/tempo-3")) },
      v.publicInputs[2] as string,
      FIELDS.size,
    );
    expect(await verifyC2b(v.proof, other)).toBe(false);
  }, 60_000);
});
