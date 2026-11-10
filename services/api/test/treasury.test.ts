import {
  domainSeparator,
  type Hex,
  keccak256,
  maxUint256,
  stringToHex,
  verifyTypedData,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, test } from "vitest";
import { TREASURY_PAYS, treasuryFromKey, treasuryTransfer } from "../src/disputes/treasury.ts";

const domain = {
  name: "PayPal USD",
  version: "1",
  chainId: 421614,
  verifyingContract: "0x637A1259C6afd7E3AdF63993cA7E58BB438aB1B1",
} as const;
const types = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

describe("the treasury's PYUSD transfer", () => {
  const treasury = privateKeyToAccount(generatePrivateKey());
  const separator = domainSeparator({ domain });
  const to = privateKeyToAccount(generatePrivateKey()).address;
  const nonce: Hex = keccak256(stringToHex("verdict digest"));

  test("is an EIP-3009 authorization the treasury signed, valid until revoked", async () => {
    const [from, payee, value, validAfter, validBefore, n, signature] = await treasuryTransfer(
      treasury,
      separator,
      { to, value: 200_000n, nonce },
    );
    expect([from, payee, value, validAfter, validBefore, n]).toEqual([
      treasury.address,
      to,
      200_000n,
      0n,
      maxUint256,
      nonce,
    ]);
    expect(
      await verifyTypedData({
        address: treasury.address,
        domain,
        types,
        primaryType: "TransferWithAuthorization",
        message: { from, to, value, validAfter, validBefore, nonce },
        signature,
      }),
    ).toBe(true);
  });

  test("is the same calldata on every retry of a verdict", async () => {
    const a = await treasuryTransfer(treasury, separator, { to, value: 1n, nonce });
    const b = await treasuryTransfer(treasury, separator, { to, value: 1n, nonce });
    expect(a).toEqual(b);
  });
});

test("the treasury pays only for refusals of a verdict that still holds", () => {
  for (const failure of ["Expired", "WarrantyWindowClosed", "CoverageNotActive"]) {
    expect(TREASURY_PAYS.has(failure)).toBe(true);
  }
  for (const failure of [
    "AlreadySettled",
    "ExceedsCoverage",
    // The reserve can be refilled and the verdict then paid on chain: the treasury would pay twice.
    "InsufficientReserve",
    "InvalidVerdictSignature",
    "NotAnchored",
    "NotKeelsonLiable",
    "NotOperatorLiable",
    "UnknownCoverage",
    "ZeroAmount",
    "payout FAILED",
  ]) {
    expect(TREASURY_PAYS.has(failure)).toBe(false);
  }
});

test("only the treasury's own key is taken", () => {
  expect(treasuryFromKey(undefined)).toBeUndefined();
  expect(() => treasuryFromKey(generatePrivateKey())).toThrow(/not 0xbEE8/);
});
