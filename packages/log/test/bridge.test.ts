import { readFileSync } from "node:fs";
import { decodeStrict, encode } from "@keelson/scitt";
import { signEs256k } from "@keelson/scitt/testing";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { Tag } from "cbor2";
import { describe, expect, test } from "vitest";
import { leafHash } from "../src/leaf.ts";
import {
  BRIDGE_CONTENT_TYPE,
  bridgeClaimsBytes,
  LeafFormatError,
  parseStatementLeaf,
} from "../src/statement.ts";
import { bridgeFromVector } from "./statement-vectors.ts";

const dir = new URL("../../../internal/alibilog/testdata/statement-v2/", import.meta.url);
const load = (name: string) => JSON.parse(readFileSync(new URL(`${name}.json`, dir), "utf8"));
const fixtureLeaf = (id: string) =>
  Uint8Array.from(
    Buffer.from(
      JSON.parse(
        readFileSync(new URL(`../../alibi/test/fixtures/${id}.alibi`, import.meta.url), "utf8"),
      ).leaf,
      "base64",
    ),
  );
const bridgeKey = hexToBytes("03".repeat(32));

const codeOf = (bytes: Uint8Array) => {
  try {
    parseStatementLeaf(bytes);
    return "ok";
  } catch (err) {
    if (err instanceof LeafFormatError) return err.code;
    throw err;
  }
};

function resign(v: { protected_hex: string }, claims: Uint8Array) {
  const s = signEs256k(hexToBytes(v.protected_hex), claims, bridgeKey);
  return encode(new Tag(18, [s.protected, s.unprotected, s.payload, s.signature]));
}

describe("bridge statements", () => {
  test.each([
    ["bridge-2of2", "01M6ZWZJHWRRHQEYNJAT7NMSV8"],
    ["bridge-degraded", "01M6ZX07MFWDDDW4199FDJHWEG"],
  ])("%s carries the v1 Alibi %s", (name, id) => {
    const v = load(name);
    const claims = bridgeFromVector(v);
    expect(bytesToHex(bridgeClaimsBytes(claims))).toBe(v.claims_hex);
    expect(v.protected_hex).toContain(bytesToHex(new TextEncoder().encode(BRIDGE_CONTENT_TYPE)));
    const parsed = parseStatementLeaf(hexToBytes(v.statement_hex));
    expect(parsed.kind).toBe("bridge");
    if (parsed.kind !== "bridge") return;
    expect(parsed.claims).toEqual(claims);
    expect(parsed.alibiId).toBe(id);
    expect(parsed.claims.predecessor).toBe(`0x${bytesToHex(leafHash(fixtureLeaf(id)))}`);
    expect(parsed.signer.toLowerCase()).toBe(v.inputs.bridge_signer.toLowerCase());
  });

  test("a payment reference claim is refused", () => {
    const v = load("bridge-2of2");
    const m = decodeStrict(hexToBytes(v.claims_hex)) as Map<number, unknown>;
    m.set(22, new Uint8Array(32));
    expect(codeOf(resign(v, encode(m)))).toBe("leaf.unknown");
  });

  test("a bridge without a predecessor is refused", () => {
    const v = load("bridge-2of2");
    const m = decodeStrict(hexToBytes(v.claims_hex)) as Map<number, unknown>;
    m.delete(23);
    expect(codeOf(resign(v, encode(m)))).toBe("leaf.field");
  });

  test("legs that signed another countersign are refused", () => {
    const v = load("bridge-2of2");
    const m = decodeStrict(hexToBytes(v.claims_hex)) as Map<number, unknown>;
    m.set(8, 101);
    expect(codeOf(resign(v, encode(m)))).toBe("leaf.digest");
  });
});
