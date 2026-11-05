import { describe, expect, test } from "vitest";
import { CHAIN_IDS, hashKeelson, keelsonDomain } from "../src/eip712.js";

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
  test.todo("Checkpoint hash matches the golden vector");

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
    expect(() => hashKeelson("Checkpoint", { ...checkpoint, origin: "0x01" }, domain)).toThrow();
    expect(() =>
      hashKeelson("Checkpoint", { ...checkpoint, rootHash: `0x${"zz".repeat(32)}` }, domain),
    ).toThrow();
    expect(() => hashKeelson("Verdict", { ...verdict, payee: "0x1234" }, domain)).toThrow();
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
