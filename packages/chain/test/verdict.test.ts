import { hashKeelson, keelsonDomain } from "@keelson/core/eip712";
import {
  decodeFunctionData,
  encodeFunctionData,
  type Hex,
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, test } from "vitest";
import { keelsonBondVaultAbi, keelsonReserveAbi } from "../src/abis.ts";
import { payWarrantyArgs } from "../src/reserve.ts";
import { claimTypedData, slashArgs, type Verdict } from "../src/verdict.ts";

const sig = (b: string): Hex => `0x${b.repeat(65)}`;
const verdict: Verdict = {
  disputeId: keccak256(stringToHex("dispute")),
  coverageId: keccak256(stringToHex("coverage")),
  agentId: 351n,
  payee: "0x467D2beBb479D9B80Ab1c461243E05A2b82387d8",
  amount: 50_000_000n,
  ruleId: 61,
  liable: 1,
  fieldId: 9,
  evidenceHash: keccak256(stringToHex("evidence")),
  inputsHash: keccak256(stringToHex("inputs")),
  policySetHash: keccak256(stringToHex("policy")),
  checkpointRoot: keccak256(stringToHex("root")),
  issuedAt: 1_800_000_000,
  deadline: 1_800_003_600,
};

describe("slashArgs", () => {
  test("packs tdx ‖ nitro for a 2-of-2 verdict and encodes `slash`", () => {
    const args = slashArgs(verdict, 54n, "2of2", { tdx: sig("aa"), nitro: sig("bb") });
    expect(args[2]).toBe(`0x${"aa".repeat(65)}${"bb".repeat(65)}`);
    const data = encodeFunctionData({ abi: keelsonBondVaultAbi, functionName: "slash", args });
    const decoded = decodeFunctionData({ abi: keelsonBondVaultAbi, data });
    expect(decoded.functionName).toBe("slash");
    expect(decoded.args?.[1]).toBe(54n);
  });

  test("sends the TDX signature alone for a degraded verdict", () => {
    expect(slashArgs(verdict, 54n, "degraded", { tdx: sig("aa"), nitro: null })[2]).toBe(sig("aa"));
  });

  test("refuses a 2-of-2 verdict without the Nitro signature", () => {
    expect(() => slashArgs(verdict, 54n, "2of2", { tdx: sig("aa"), nitro: null })).toThrow(
      TypeError,
    );
  });
});

describe("payWarrantyArgs", () => {
  test("encodes `payWarranty` with both signatures", () => {
    const args = payWarrantyArgs({ ...verdict, liable: 2 }, 54n, {
      tdx: sig("aa"),
      nitro: sig("bb"),
    });
    const data = encodeFunctionData({ abi: keelsonReserveAbi, functionName: "payWarranty", args });
    expect((data.length - 2) / 2).toBeGreaterThan(4 + 14 * 32 + 130);
  });
});

describe("claimTypedData", () => {
  test("is the `Claim` struct under the holder's domain", async () => {
    const account = privateKeyToAccount(keccak256(stringToHex("merchant")));
    const vault = "0xb39898Ef4333f3CB32d1B420E744f5a1Aa2ae2Bf";
    const claim = {
      account: account.address,
      to: verdict.payee,
      nonce: 0n,
      deadline: 1_800_003_600n,
    };
    const typed = claimTypedData(claim, 421614, vault);
    expect(typed.domain).toEqual(keelsonDomain(421614, vault));
    const signature = await account.signTypedData(typed);
    expect(await recoverTypedDataAddress({ ...typed, signature })).toBe(account.address);
    expect(hashTypedData(typed)).toBe(hashKeelson("Claim", claim, keelsonDomain(421614, vault)));
  });
});
