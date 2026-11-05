import { BN254_FR_MODULUS as BB_MODULUS } from "@aztec/bb.js";
import { describe, expect, test } from "vitest";
import { BN254_FR_MODULUS, fieldFromAscii, KEELSON_MANDATE, poseidon2 } from "../src/poseidon2.ts";
import vectors from "./vectors/poseidon2.json" with { type: "json" };

describe("poseidon2", () => {
  test.each(vectors)("matches the golden vector $name", async ({ input, expected }) => {
    const hash = await poseidon2(input.map((value) => BigInt(value)));
    expect(`0x${hash.toString(16).padStart(64, "0")}`).toBe(expected);
  });

  test("uses Barretenberg's field modulus", () => {
    expect(BN254_FR_MODULUS).toBe(BB_MODULUS);
  });

  test("rejects an input at or above the field modulus", async () => {
    await expect(poseidon2([BN254_FR_MODULUS])).rejects.toThrow(RangeError);
    await expect(poseidon2([-1n])).rejects.toThrow(RangeError);
  });

  test("is deterministic and input-sensitive", async () => {
    const h = await poseidon2([1n, 2n]);
    expect(await poseidon2([1n, 2n])).toBe(h);
    expect(await poseidon2([2n, 1n])).not.toBe(h);
    expect(h).toBeLessThan(BN254_FR_MODULUS);
  });

  test("encodes the domain tag as big-endian ASCII", () => {
    const hex = Buffer.from("KEELSON_MANDATE", "ascii").toString("hex");
    expect(fieldFromAscii("KEELSON_MANDATE")).toBe(BigInt(`0x${hex}`));
    expect(KEELSON_MANDATE).toBe(BigInt(`0x${hex}`));
  });

  test("rejects a tag longer than 31 bytes", () => {
    expect(() => fieldFromAscii("a".repeat(32))).toThrow();
    expect(() => fieldFromAscii("a".repeat(31))).not.toThrow();
  });

  test("rejects non-ASCII and empty tags", () => {
    expect(() => fieldFromAscii("é")).toThrow(RangeError);
    expect(() => fieldFromAscii("")).toThrow(RangeError);
  });
});
