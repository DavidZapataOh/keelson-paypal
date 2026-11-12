import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vitest";
import { decodeStrict, encode, ScittFormatError } from "../src/cbor.ts";

describe("deterministic CBOR", () => {
  test("map keys are written in RFC 8949 §4.2.1 order", () => {
    const bytes = encode(
      new Map<number, unknown>([
        [15, 1],
        [1, -47],
        [4, new Uint8Array(20)],
      ]),
    );
    expect(bytes[0]).toBe(0xa3);
    expect(bytes[1]).toBe(0x01);
    expect(bytes.subarray(2, 5)).toEqual(Uint8Array.of(0x38, 0x2e, 0x04));
    expect(bytes[bytes.length - 2]).toBe(0x0f);
  });

  test("a canonical value round-trips byte-identically", () => {
    const bytes = encode(
      new Map<number, unknown>([
        [1, "a"],
        [2, [1, 2]],
      ]),
    );
    expect(encode(decodeStrict(bytes))).toEqual(bytes);
  });

  test.each([
    ["an indefinite-length array", "9f01ff"],
    ["unsorted map keys", "a203000100"],
    ["a duplicate map key", "a201000100"],
    ["a non-preferred integer", "1800"],
  ])("refuses %s", (_, hex) => {
    expect(() => decodeStrict(hexToBytes(hex))).toThrow(ScittFormatError);
    try {
      decodeStrict(hexToBytes(hex));
    } catch (err) {
      expect((err as ScittFormatError).code).toBe("noncanonical");
    }
  });

  test("refuses bytes that are not CBOR", () => {
    expect(() => decodeStrict(hexToBytes("ff"))).toThrow(expect.objectContaining({ code: "cbor" }));
  });
});
