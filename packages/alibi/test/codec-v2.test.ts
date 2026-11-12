import { decodeSign1, encodeSign1 } from "@keelson/scitt";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vitest";
import { fromBase64, toBase64, toBase64url } from "../src/b64.ts";
import {
  AlibiFormatError,
  decodeAny,
  decodeStatementFile,
  encodeAny,
  leafHashOf,
  receiptOf,
  registeredOf,
  statementOf,
  versionOf,
} from "../src/codec.ts";
import { verifyUrl } from "../src/qr.ts";
import { RECEIPT_MEDIA_TYPE_V2, STATEMENT_MEDIA_TYPE } from "../src/schema.ts";
import { fixtures } from "./fixtures.ts";
import { v2Bundle, vector } from "./v2.ts";

const v = vector("allow-2of2");

describe("Alibi bundle v2", () => {
  test("round-trips byte-identically", () => {
    const bytes = encodeAny(v2Bundle());
    expect(encodeAny(decodeAny(bytes))).toEqual(bytes);
    expect(versionOf(decodeAny(bytes))).toBe(2);
  });

  test("the registered statement is the leaf and its hash the leaf hash", () => {
    const b = v2Bundle();
    expect(bytesToHex(registeredOf(b))).toBe(v.statement_hex);
    expect(bytesToHex(leafHashOf(b))).toBe(v.leaf_hash_hex);
    expect(statementOf(b)).toEqual(fromBase64(b.statement));
  });

  test("the verify URL names the leaf hash and the statement's chain", () => {
    const b = v2Bundle();
    expect(verifyUrl(b)).toBe(
      `https://verify.keelson.finance/a/${b.alibi_id}#${toBase64url(hexToBytes(v.leaf_hash_hex))}.0.421614`,
    );
  });

  test("its public receipt is the statement and the log proof", () => {
    const b = v2Bundle();
    expect(receiptOf(b)).toEqual({
      type: RECEIPT_MEDIA_TYPE_V2,
      alibi_id: b.alibi_id,
      statement: b.statement,
      tlog_proof: b.tlog_proof,
    });
    expect(versionOf(decodeAny(encodeAny(receiptOf(b))))).toBe(2);
  });

  test("v1 bundles still decode as v1, byte for byte", () => {
    for (const f of fixtures) {
      const a = decodeAny(f.bytes);
      expect(versionOf(a)).toBe(1);
      expect(encodeAny(a)).toEqual(f.bytes);
    }
  });

  test.each(["leaf", "tee", "leaf_view"])("refuses a v2 bundle carrying v1's %s", (key) => {
    const b = { ...v2Bundle(), [key]: "x" };
    expect(() => encodeAny(b as never)).toThrow(AlibiFormatError);
  });

  test("refuses a statement with an unprotected label other than 394 and 270", () => {
    const b = v2Bundle();
    expect(() =>
      encodeAny({ ...b, statement: toBase64(withLabel(registeredOf(b), 33)) } as never),
    ).toThrow(expect.objectContaining({ code: "schema", pointer: "/statement" }));
  });

  test("a bare .cose file reads as a v2 receipt without a log proof", () => {
    const b = v2Bundle();
    const r = decodeStatementFile(statementOf(b));
    expect(r).toEqual({
      type: RECEIPT_MEDIA_TYPE_V2,
      alibi_id: b.alibi_id,
      statement: b.statement,
    });
    expect(decodeStatementFile(new TextEncoder().encode("{}"))).toBeNull();
    expect(STATEMENT_MEDIA_TYPE).toBe("application/scitt-statement+cose");
  });
});

function withLabel(statement: Uint8Array, label: number): Uint8Array {
  const s = decodeSign1(statement);
  return encodeSign1({ ...s, unprotected: new Map([[label, new Uint8Array(1)]]) });
}
