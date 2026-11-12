import { readFileSync } from "node:fs";
import { cardAuthorizationDigest, cardSettlementDigest, keelsonDomain } from "@keelson/core/eip712";
import { decodeStrict, encode } from "@keelson/scitt";
import { signEs256k } from "@keelson/scitt/testing";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { Tag } from "cbor2";
import { describe, expect, test } from "vitest";
import {
  CARD_AUTHORIZATION_CONTENT_TYPE,
  CARD_SETTLEMENT_CONTENT_TYPE,
  CLAIMS_CONTENT_TYPE,
  cardAuthorizationClaimsBytes,
  cardSettlementClaimsBytes,
  LeafFormatError,
  parseStatementLeaf,
} from "../src/statement.ts";
import { CARD_VECTOR_NAMES, cardFromVector, vectorKeys } from "./statement-vectors.ts";

const dir = new URL("../../../internal/alibilog/testdata/statement-v2/", import.meta.url);
const load = (name: string) => JSON.parse(readFileSync(new URL(`${name}.json`, dir), "utf8"));

describe("card statement vectors", () => {
  test.each(CARD_VECTOR_NAMES)("%s", (name) => {
    const v = load(name);
    const c = cardFromVector(v);
    const claims =
      c.kind === "card-authorization"
        ? cardAuthorizationClaimsBytes(c.claims)
        : cardSettlementClaimsBytes(c.claims);
    expect(bytesToHex(claims)).toBe(v.claims_hex);
    const parsed = parseStatementLeaf(hexToBytes(v.statement_hex));
    expect(parsed.kind).toBe(c.kind);
    expect(parsed.alibiId).toBe(v.inputs.alibi_id);
    expect("card" in parsed && parsed.card).toEqual(c.claims);
    const domain = keelsonDomain(v.inputs.chain_id, v.inputs.verifying_contract);
    const digest =
      c.kind === "card-authorization"
        ? cardAuthorizationDigest(c.claims.authorization, domain)
        : cardSettlementDigest(c.claims.settlement, domain);
    expect(digest.slice(2)).toBe(v.digest_hex);
  });

  test("the content types are distinct from the purchase one", () => {
    expect(
      new Set([CLAIMS_CONTENT_TYPE, CARD_AUTHORIZATION_CONTENT_TYPE, CARD_SETTLEMENT_CONTENT_TYPE])
        .size,
    ).toBe(3);
    expect(load("card-auth-approve").protected_hex).toContain(
      bytesToHex(new TextEncoder().encode(CARD_AUTHORIZATION_CONTENT_TYPE)),
    );
  });

  test("each worst case fits in 1024 bytes", () => {
    for (const name of CARD_VECTOR_NAMES) {
      expect(hexToBytes(load(name).statement_hex).length).toBeLessThanOrEqual(900);
    }
  });
});

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
  test("card claims under the purchase content type", () => {
    const v = load("card-auth-approve");
    const purchase = load("allow-2of2");
    const s = signEs256k(
      hexToBytes(purchase.protected_hex),
      hexToBytes(v.claims_hex),
      vectorKeys[1],
    );
    expect(codeOf(encode(new Tag(18, [s.protected, s.unprotected, s.payload, s.signature])))).toBe(
      "leaf.field",
    );
  });

  test("a card statement without a parent", () => {
    const v = load("card-auth-approve");
    const claims = decodeStrict(hexToBytes(v.claims_hex)) as Map<number, unknown>;
    claims.delete(14);
    const s = signEs256k(hexToBytes(v.protected_hex), encode(claims), vectorKeys[1]);
    expect(codeOf(encode(new Tag(18, [s.protected, s.unprotected, s.payload, s.signature])))).toBe(
      "leaf.field",
    );
  });
});
