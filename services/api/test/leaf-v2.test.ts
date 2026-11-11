import { readFileSync } from "node:fs";

import { getAddress, type Hex, hexToBytes as viemHex } from "viem";

const hexToBytes = (h: string) => viemHex(`0x${h}`);

import { describe, expect, test } from "vitest";
import { statementLeaf } from "../src/pipeline/leaf.ts";

const vector = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../internal/alibilog/testdata/statement-v2/${name}.json`, import.meta.url),
      "utf8",
    ),
  );

function stored(v: ReturnType<typeof vector>) {
  const legs = v.inputs.legs as { signer: Hex; signature: Hex }[];
  return {
    countersign: v.inputs.countersign,
    digest: `0x${v.countersign_digest_hex}` as Hex,
    mode: v.inputs.mode,
    signatures: {
      tdx: legs[0]?.signature as Hex,
      nitro: (legs[1]?.signature ?? null) as Hex | null,
    },
    signers: {
      tdx: getAddress(legs[0]?.signer as Hex),
      nitro: legs[1] ? getAddress(legs[1].signer) : null,
    },
  };
}

describe("a purchase's v2 leaf", () => {
  test.each(["allow-2of2", "allow-degraded"])("%s: the stored statement is the leaf", (name) => {
    const v = vector(name);
    const bytes = hexToBytes(v.statement_hex);
    expect(statementLeaf(bytes, stored(v))).toEqual(bytes);
  });

  test("a statement of another countersign is refused", () => {
    const v = vector("allow-2of2");
    const other = stored(v);
    other.countersign = { ...other.countersign, amount: "101" };
    expect(() => statementLeaf(hexToBytes(v.statement_hex), other)).toThrow(/countersign/);
  });

  test("a statement whose mode is not the purchase's is refused", () => {
    const v = vector("allow-2of2");
    expect(() =>
      statementLeaf(hexToBytes(v.statement_hex), { ...stored(v), mode: "degraded" }),
    ).toThrow(/mode/);
  });

  test("a statement signed by other legs is refused", () => {
    const v = vector("allow-2of2");
    const s = stored(v);
    s.signatures.tdx = `0x${"00".repeat(65)}` as Hex;
    expect(() => statementLeaf(hexToBytes(v.statement_hex), s)).toThrow(/signature/);
  });
});
