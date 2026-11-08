import { createHash } from "node:crypto";
import { hashKeelson, keelsonDomain } from "@keelson/core/eip712";
import { p256 } from "@noble/curves/nist.js";
import { hashTypedData, hexToBytes, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, test } from "vitest";
import verifyVectors from "../../mandate/test/vectors/webauthn.json" with { type: "json" };
import captures from "../../mandate/test/vectors/webauthn-captures.json" with { type: "json" };
import {
  passkeyPublicKey,
  payoutAddressTypedData,
  toAssertion,
  userKeyHash,
  withdrawalTypedData,
} from "../src/coverage.ts";

const N = p256.Point.CURVE().n;
const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());
const sec1 = verifyVectors.find((v) => v.name === "verify/ok/webauthn.get")?.input
  .publicKeySec1 as string;
const qx = `0x${sec1.slice(4, 68)}` as const;
const qy = `0x${sec1.slice(68)}` as const;

describe("toAssertion", () => {
  test.each(["webauthn", "payment"] as const)("encodes the %s capture", (kind) => {
    const signed = captures.signed[kind].assertion;
    const a = toAssertion(signed);
    const type = kind === "webauthn" ? "webauthn.get" : "payment.get";
    const json = Buffer.from(a.clientDataJSON, "utf8");
    expect(json.subarray(Number(a.typeIndex)).toString().startsWith(`"type":"${type}"`)).toBe(true);
    const challenge = JSON.parse(a.clientDataJSON).challenge as string;
    expect(
      json.subarray(Number(a.challengeIndex)).toString().startsWith(`"challenge":"${challenge}"`),
    ).toBe(true);
    expect(BigInt(a.s) <= N / 2n).toBe(true);
    const ad = hexToBytes(a.authenticatorData);
    const message = new Uint8Array([...ad, ...sha256(json)]);
    const sig = new p256.Signature(BigInt(a.r), BigInt(a.s)).toBytes("compact");
    const pub = hexToBytes(`0x04${qx.slice(2)}${qy.slice(2)}`);
    expect(p256.verify(sig, sha256(message), pub, { prehash: false })).toBe(true);
  });

  test("normalizes a high-S signature to the same signature", () => {
    const signed = captures.signed.webauthn.assertion;
    const { r, s } = p256.Signature.fromBytes(Buffer.from(signed.signature, "base64url"), "der");
    const high = s > N / 2n ? s : N - s;
    const der = new p256.Signature(r, high).toBytes("der");
    const a = toAssertion({ ...signed, signature: Buffer.from(der).toString("base64url") });
    expect(BigInt(a.s)).toBe(N - high);
    expect(BigInt(a.r)).toBe(r);
  });

  test("refuses a type other than webauthn.get or payment.get", () => {
    const signed = captures.signed.webauthn.assertion;
    const json = Buffer.from(signed.clientDataJSON, "base64url")
      .toString()
      .replace("webauthn.get", "webauthn.create");
    expect(() =>
      toAssertion({ ...signed, clientDataJSON: Buffer.from(json).toString("base64url") }),
    ).toThrow(TypeError);
  });
});

describe("passkeyPublicKey", () => {
  test("gives the JWK coordinates and their hash", () => {
    const jwk = {
      kty: "EC",
      crv: "P-256",
      x: Buffer.from(hexToBytes(qx)).toString("base64url"),
      y: Buffer.from(hexToBytes(qy)).toString("base64url"),
    };
    expect(passkeyPublicKey(jwk)).toEqual({ qx, qy });
    expect(userKeyHash(qx, qy)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(() => passkeyPublicKey({ ...jwk, crv: "P-384" })).toThrow(TypeError);
  });
});

describe("vault typed data", () => {
  const vault = "0x69ccD2fB3a85f590F2A8f431cca3ecc2e9Bf3c14" as const;
  const account = privateKeyToAccount(`0x${"11".repeat(32)}`);

  test("a withdrawal request is signed under the vault's domain", async () => {
    const request = {
      agentId: 351n,
      amount: 10_000_000n,
      to: account.address,
      nonce: 0n,
      deadline: 1n,
    };
    const typed = withdrawalTypedData(request, 421614, vault);
    expect(typed.domain).toEqual({
      name: "Keelson",
      version: "1",
      chainId: 421614,
      verifyingContract: vault,
    });
    const signature = await account.signTypedData(typed);
    expect(await recoverTypedDataAddress({ ...typed, signature })).toBe(account.address);
    expect(hashTypedData(typed)).toBe(
      hashKeelson("WithdrawalRequest", request, keelsonDomain(421614, vault)),
    );
  });

  test("a payout address is signed under the vault's domain", () => {
    const payout = { merchant: account.address, payout: vault, nonce: 0n, deadline: 1n };
    const typed = payoutAddressTypedData(payout, 421614, vault);
    expect(hashTypedData(typed)).toBe(
      hashKeelson("PayoutAddress", payout, keelsonDomain(421614, vault)),
    );
  });
});
