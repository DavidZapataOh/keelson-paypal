import { describe, expect, test } from "vitest";
import {
  CHAIN_IDS,
  hashKeelson,
  KEELSON_TYPES,
  type KeelsonChainId,
  type KeelsonPrimaryType,
  keelsonDomain,
} from "../src/eip712.ts";
import vectors from "./vectors/eip712.json" with { type: "json" };

const verifyingContract = "0x0000000000000000000000000000000000000001" as const;
const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const checkpoint = { origin: word(1), treeSize: 1n, rootHash: word(2) };
const verdict = {
  disputeId: word(1),
  coverageId: word(2),
  agentId: 1n,
  payee: verifyingContract,
  amount: 1_000_000n,
  ruleId: 1,
  liable: 1,
  fieldId: 0,
  evidenceHash: word(3),
  inputsHash: word(4),
  policySetHash: word(5),
  checkpointRoot: word(6),
  issuedAt: 1_700_000_000,
  deadline: 1_700_086_400,
} as const;

describe("eip712", () => {
  test.each(vectors)("matches the golden vector $name", ({ input, expected }) => {
    const primaryType = input.primaryType as KeelsonPrimaryType;
    const message = Object.fromEntries(
      KEELSON_TYPES[primaryType].map(({ name, type }) => {
        const raw = (input.message as Record<string, string>)[name] as string;
        return [name, type.startsWith("uint") ? BigInt(raw) : raw];
      }),
    );
    const domain = keelsonDomain(input.chainId as KeelsonChainId, input.verifyingContract as never);
    expect(hashKeelson(primaryType, message as never, domain)).toBe(expected);
  });

  test("rejects an unsupported chain id", () => {
    expect(() => keelsonDomain(1 as never, verifyingContract)).toThrow();
  });

  test("builds the domain", () => {
    expect(keelsonDomain(CHAIN_IDS.arbitrumSepolia, verifyingContract)).toEqual({
      name: "Keelson",
      version: "1",
      chainId: 421614,
      verifyingContract,
    });
  });

  test("rejects an out-of-range uint96", () => {
    const domain = keelsonDomain(421614, verifyingContract);
    expect(() => hashKeelson("Verdict", { ...verdict, amount: 2n ** 96n }, domain)).toThrow(
      RangeError,
    );
    expect(hashKeelson("Verdict", { ...verdict, amount: 2n ** 96n - 1n }, domain)).toMatch(
      /^0x[0-9a-f]{64}$/,
    );
  });

  test("rejects a negative or out-of-range small uint", () => {
    const domain = keelsonDomain(421614, verifyingContract);
    expect(() => hashKeelson("Verdict", { ...verdict, ruleId: 256 }, domain)).toThrow(RangeError);
    expect(() => hashKeelson("Verdict", { ...verdict, liable: -1 }, domain)).toThrow(RangeError);
  });

  test("hash differs across chain ids", () => {
    const a = hashKeelson("Checkpoint", checkpoint, keelsonDomain(421614, verifyingContract));
    const b = hashKeelson("Checkpoint", checkpoint, keelsonDomain(42161, verifyingContract));
    expect(a).not.toBe(b);
  });

  test("accepts chain 42161", () => {
    expect(keelsonDomain(CHAIN_IDS.arbitrumOne, verifyingContract).chainId).toBe(42161);
  });

  test("rejects malformed bytes32 and address values", () => {
    const domain = keelsonDomain(421614, verifyingContract);
    expect(() => hashKeelson("Checkpoint", { ...checkpoint, origin: "0x01" }, domain)).toThrow(
      TypeError,
    );
    expect(() =>
      hashKeelson("Checkpoint", { ...checkpoint, rootHash: `0x${"zz".repeat(32)}` }, domain),
    ).toThrow(TypeError);
    expect(() => hashKeelson("Verdict", { ...verdict, payee: "0x1234" }, domain)).toThrow(
      TypeError,
    );
  });

  test("rejects a mixed-case address with a bad EIP-55 checksum", () => {
    const domain = keelsonDomain(421614, verifyingContract);
    const payee = "0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    expect(() => hashKeelson("Verdict", { ...verdict, payee }, domain)).toThrow(
      new TypeError("Verdict.payee must be an address"),
    );
    expect(() =>
      hashKeelson("Verdict", { ...verdict, payee: payee.toLowerCase() as `0x${string}` }, domain),
    ).not.toThrow();
  });

  test("bounds uint256", () => {
    const domain = keelsonDomain(421614, verifyingContract);
    const withdrawal = { agentId: 1n, amount: 1n, to: verifyingContract, nonce: 0n, deadline: 1n };
    expect(() =>
      hashKeelson("WithdrawalRequest", { ...withdrawal, nonce: 2n ** 256n }, domain),
    ).toThrow(RangeError);
    expect(() => hashKeelson("WithdrawalRequest", { ...withdrawal, nonce: -1n }, domain)).toThrow(
      RangeError,
    );
    expect(
      hashKeelson("WithdrawalRequest", { ...withdrawal, nonce: 2n ** 256n - 1n }, domain),
    ).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
