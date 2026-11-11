import { readFileSync } from "node:fs";
import { decodeStrict as decodeClaims, encode } from "@keelson/scitt";
import { signEs256k } from "@keelson/scitt/testing";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { Tag } from "cbor2";
import { describe, expect, test } from "vitest";
import {
  CLAIMS_CONTENT_TYPE,
  claimsBytes,
  LeafFormatError,
  leafVersion,
  parseStatementLeaf,
  type StatementClaims,
  statementProtected,
  statementToBeSigned,
} from "../src/statement.ts";
import { fromVector, VECTOR_NAMES, vectorKeys } from "./statement-vectors.ts";

const dir = new URL("../../../internal/alibilog/testdata/statement-v2/", import.meta.url);
const load = (name: string) => JSON.parse(readFileSync(new URL(`${name}.json`, dir), "utf8"));

describe("golden vectors", () => {
  test.each(VECTOR_NAMES)("%s", (name) => {
    const v = load(name);
    const { claims, alibiId } = fromVector(v);
    expect(bytesToHex(claimsBytes(claims))).toBe(v.claims_hex);
    const signer = claims.mode === "2of2" ? claims.legs[1]?.signer : claims.legs[0].signer;
    expect(
      bytesToHex(
        statementProtected(signer as `0x${string}`, alibiId, Number(claims.countersign.issuedAt)),
      ),
    ).toBe(v.protected_hex);
    expect(bytesToHex(statementToBeSigned(claims, alibiId))).toBe(v.tbs_hex);
    const parsed = parseStatementLeaf(hexToBytes(v.statement_hex));
    expect(parsed.alibiId).toBe(alibiId);
    expect(parsed.signer.toLowerCase()).toBe(signer?.toLowerCase());
    expect(parsed.kind).toBe("purchase");
    expect(parsed.kind === "purchase" && parsed.claims).toEqual(claims);
  });

  test("the claims map has integer keys 1..21 (22 only with a payment reference), in order", () => {
    const v = load("allow-2of2");
    expect(v.claims_hex.slice(0, 6)).toBe("b60102"); // map(22), key 1 => 2
    expect(load("card-2of2").claims_hex.slice(0, 2)).toBe("b5"); // map(21)
  });

  test("the protected header is {1: -47, 3: content type, 4: kid, 15: {1, 2, 6}}", () => {
    const v = load("allow-degraded");
    expect(v.protected_hex.slice(0, 8)).toBe("a401382e");
    expect(v.protected_hex).toContain(bytesToHex(new TextEncoder().encode(CLAIMS_CONTENT_TYPE)));
  });
});

describe("size", () => {
  test("the worst case fits in 1024 bytes", () => {
    const { claims, alibiId } = fromVector(load("allow-2of2"));
    const worst: StatementClaims = {
      ...claims,
      countersign: {
        ...claims.countersign,
        agentId: (1n << 256n) - 1n,
        amount: (1n << 64n) - 1n,
        currency: 65535,
        category: 255,
        decision: 255,
        failedFieldsMask: 2 ** 32 - 1,
        issuedAt: 2 ** 40 - 1,
        expiresAt: 2 ** 40 - 1,
      },
    };
    const leaf = signStatement(worst, alibiId);
    console.info(`worst-case v2 leaf: ${leaf.length} bytes`);
    expect(leaf.length).toBeLessThanOrEqual(1024);
  });
});

/** Signs with the vector keys (index 0 = tdx, 1 = nitro); `kid` defaults to the mode's leg. */
function signStatement(
  c: StatementClaims,
  alibiId: string,
  as?: 0 | 1,
  unprotected?: Map<number, unknown>,
) {
  const leg = as ?? (c.mode === "2of2" ? 1 : 0);
  const signer = c.legs[leg]?.signer ?? c.legs[0].signer;
  const prot = statementProtected(signer, alibiId, Number(c.countersign.issuedAt));
  const s = signEs256k(
    prot,
    claimsBytes(c),
    vectorKeys[leg] as Uint8Array,
    unprotected ? { unprotected } : {},
  );
  return encode(new Tag(18, [s.protected, s.unprotected, s.payload, s.signature]));
}

const codeOf = (bytes: Uint8Array) => {
  try {
    parseStatementLeaf(bytes);
    return "ok";
  } catch (err) {
    if (err instanceof LeafFormatError) return err.code;
    throw err;
  }
};

describe("refusals", () => {
  const base = fromVector(load("allow-2of2"));
  const degraded = fromVector(load("allow-degraded"));

  test("a 2of2 with one leg, or a degraded with two", () => {
    expect(
      codeOf(signStatement({ ...base.claims, legs: [base.claims.legs[0]] }, base.alibiId, 0)),
    ).toBe("leaf.mode");
    expect(codeOf(signStatement({ ...base.claims, mode: "degraded" }, base.alibiId, 0))).toBe(
      "leaf.mode",
    );
  });

  test("a statement signed by a leg other than the one the mode names", () => {
    expect(codeOf(signStatement(base.claims, base.alibiId, 0))).toBe("leaf.signer");
  });

  test("a non-empty unprotected header", () => {
    expect(
      codeOf(
        signStatement(base.claims, base.alibiId, undefined, new Map([[33, new Uint8Array(1)]])),
      ),
    ).toBe("leaf.unprotected");
  });

  test("legs whose EIP-712 signatures are over another digest", () => {
    const legs = base.claims.legs.map((l) => ({ ...l })) as StatementClaims["legs"];
    const other = { ...base.claims, countersign: { ...base.claims.countersign, amount: 101n } };
    const forged = { ...other, legs } as StatementClaims;
    expect(codeOf(signStatement(forged, base.alibiId))).toBe("leaf.digest");
  });

  test("a statement signature by another key", () => {
    const bytes = signStatement(degraded.claims, degraded.alibiId);
    const flipped = bytes.slice();
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] as number) ^ 1;
    expect(codeOf(flipped)).toBe("leaf.signature");
  });

  test("non-canonical claims", () => {
    const v = load("allow-degraded");
    const bytes = hexToBytes(v.statement_hex);
    // The tag-18 header written in a non-preferred form.
    const longTag = Uint8Array.of(0xd8, 0x12, ...bytes.subarray(1));
    expect(codeOf(longTag)).toBe("leaf.noncanonical");
  });

  test("an unknown claim key", () => {
    const { claims, alibiId } = degraded;
    const prot = statementProtected(
      claims.legs[0].signer,
      alibiId,
      Number(claims.countersign.issuedAt),
    );
    const map = new Map([...(decodeClaims(claimsBytes(claims)) as Map<number, unknown>), [23, 0]]);
    const s = signEs256k(prot, encode(map), vectorKeys[0] as Uint8Array);
    expect(codeOf(encode(new Tag(18, [s.protected, s.unprotected, s.payload, s.signature])))).toBe(
      "leaf.unknown",
    );
  });

  test("a leaf over 1024 bytes", () => {
    expect(codeOf(new Uint8Array(1025).fill(0xd2))).toBe("leaf.size");
  });
});

describe("leafVersion", () => {
  test("tells v2 from v1 by the first byte", () => {
    expect(leafVersion(hexToBytes(load("allow-2of2").statement_hex))).toBe(2);
    expect(leafVersion(new TextEncoder().encode("keelson.finance/alibi/v1\n{}"))).toBe(1);
    expect(() => leafVersion(Uint8Array.of(0x7b))).toThrow(LeafFormatError);
  });
});
