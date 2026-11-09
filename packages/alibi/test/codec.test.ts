import { describe, expect, test } from "vitest";
import { decodeAlibi, decodeReceipt, encodeAlibi, encodeReceipt, receiptOf } from "../src/codec.ts";
import { verifyUrl } from "../src/qr.ts";
import { fixtures } from "./fixtures.ts";

const encoder = new TextEncoder();
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("one byte form per bundle", () => {
  test("there are fixtures in both modes", () => {
    expect(new Set(fixtures.map((f) => f.mode))).toEqual(new Set(["2of2", "degraded"]));
  });

  test.each(fixtures.map((f) => [f.id, f] as const))("%s re-encodes to its bytes", (_, f) => {
    expect(encodeAlibi(f.bundle)).toEqual(f.bytes);
    const r = receiptOf(f.bundle);
    expect(decodeReceipt(encodeReceipt(r))).toEqual(r);
  });

  const f = fixtures[0];
  test.skipIf(!f)("other byte forms are refused with their code", () => {
    const s = text(f?.bytes as Uint8Array);
    const code = (bytes: Uint8Array) => {
      try {
        decodeAlibi(bytes);
        return "accepted";
      } catch (err) {
        return (err as { code: string }).code;
      }
    };
    expect(code(encoder.encode(` ${s}`))).toBe("noncanonical");
    expect(code(encoder.encode(s.replace('"alibi_id":', '"alibi_id" :')))).toBe("noncanonical");
    const value = JSON.parse(s) as Record<string, unknown>;
    const { alibi_id, ...rest } = value;
    expect(code(encoder.encode(JSON.stringify({ ...rest, alibi_id })))).toBe("noncanonical");
    expect(code(encoder.encode(s.replace("{", `{"alibi_id":"${alibi_id}",`)))).toBe("noncanonical");
    expect(code(encoder.encode(s.replace("{", '{"aaa":1,')))).toBe("schema");
    expect(code(encoder.encode(s.slice(1)))).toBe("json");
    expect(code(Uint8Array.of(0xef, 0xbb, 0xbf, ...(f as { bytes: Uint8Array }).bytes))).toBe(
      "json",
    );
  });

  test.each(fixtures.map((f) => [f.id, f] as const))("%s has its canonical verify url", (_, f) => {
    expect(verifyUrl(f.bundle)).toMatch(
      f.anchored
        ? /^https:\/\/verify\.keelson\.finance\/a\/[0-9A-HJKMNP-TV-Z]{26}#[A-Za-z0-9_-]{43}\.[1-9][0-9]*\.421614$/
        : /^https:\/\/verify\.keelson\.finance\/a\/[0-9A-HJKMNP-TV-Z]{26}#[A-Za-z0-9_-]{43}\.0\.421614$/,
    );
  });
});
