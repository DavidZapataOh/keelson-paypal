import { describe, expect, it } from "vitest";
import { isUlid, newId, ulidToBytes, ulidToBytes32 } from "../src/ulid.js";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function bytesToUlid(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < 26; i++) {
    out = ALPHABET[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

describe("newId", () => {
  it("is strictly increasing across 10,000 calls", () => {
    let prev = newId();
    for (let i = 0; i < 10_000; i++) {
      const next = newId();
      expect(next > prev).toBe(true);
      prev = next;
    }
  });

  it("produces valid ULIDs", () => {
    expect(isUlid(newId())).toBe(true);
  });
});

describe("isUlid", () => {
  it("accepts a canonical ULID", () => {
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
    expect(isUlid("7ZZZZZZZZZZZZZZZZZZZZZZZZZ")).toBe(true);
  });

  it("rejects overflow, wrong length, lowercase and excluded letters", () => {
    expect(isUlid("8ZZZZZZZZZZZZZZZZZZZZZZZZZ")).toBe(false);
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FA")).toBe(false);
    expect(isUlid("01arz3ndektsv4rrffq69g5fav")).toBe(false);
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAU")).toBe(false);
  });
});

describe("ulidToBytes", () => {
  it("round-trips through the encoding", () => {
    for (const id of [
      newId(),
      newId(),
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "7ZZZZZZZZZZZZZZZZZZZZZZZZZ",
    ]) {
      const bytes = ulidToBytes(id);
      expect(bytes).toHaveLength(16);
      expect(bytesToUlid(bytes)).toBe(id);
    }
  });

  it("throws on an invalid ULID", () => {
    expect(() => ulidToBytes("8ZZZZZZZZZZZZZZZZZZZZZZZZZ")).toThrow(TypeError);
  });
});

describe("ulidToBytes32", () => {
  it("right-aligns the 16 bytes in 32", () => {
    const hex = ulidToBytes32("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(hex).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hex.slice(2, 34)).toBe("0".repeat(32));
    expect(hex.slice(34)).toBe(
      Buffer.from(ulidToBytes("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toString("hex"),
    );
  });
});
