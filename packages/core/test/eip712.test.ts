import { type Hex, hashTypedData, type TypedDataDomain } from "viem";
import { signTypedData } from "viem/accounts";
import { describe, expect, test } from "vitest";
import {
  BIT_EXTRA,
  CHAIN_IDS,
  type Countersign,
  countersignDigest,
  failedFieldsMask,
  hashKeelson,
  KEELSON_TYPES,
  type KeelsonChainId,
  type KeelsonPrimaryType,
  keelsonDomain,
  reportData,
  type SignerBinding,
  TeeKind,
} from "../src/eip712.ts";
import countersignVectors from "./vectors/countersign.json" with { type: "json" };
import vectors from "./vectors/eip712.json" with { type: "json" };
import maskVectors from "./vectors/failed-fields-mask.json" with { type: "json" };
import reportDataVectors from "./vectors/report-data.json" with { type: "json" };

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

  test.each([
    [
      "Coverage",
      "Coverage(bytes32 coverageId,uint256 agentId,address merchant,uint96 amount,uint96 premium,uint40 expiresAt,bytes32 mandateHash,bytes32 amberCommitment,bytes32 userKeyHash)",
    ],
    [
      "CoverageBatch",
      "CoverageBatch(uint256 agentId,bytes32 root,uint128 total,uint96 premium,uint40 expiresAt,bytes32 checkpointRoot,uint64 treeSize)",
    ],
    ["Claim", "Claim(address account,address to,uint256 nonce,uint256 deadline)"],
  ] as const)("encodes %s as the vault expects", (primaryType, typeString) => {
    const fields = KEELSON_TYPES[primaryType].map(({ name, type }) => `${type} ${name}`);
    expect(`${primaryType}(${fields.join(",")})`).toBe(typeString);
    for (const chainId of [CHAIN_IDS.arbitrumSepolia, CHAIN_IDS.arbitrumOne]) {
      expect(vectors.some((v) => v.name === `${primaryType}/${chainId}`)).toBe(true);
    }
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

describe("countersign", () => {
  test.each(countersignVectors)("matches the golden vector $name", async ({ input, expected }) => {
    const message = parseCountersign(input.message);
    const domain = { ...input.domain, chainId: BigInt(input.domain.chainId) } as TypedDataDomain;
    expect(countersignDigest(message, domain)).toBe(expected.digest);
    expect(
      await signTypedData({
        privateKey: input.privateKey as Hex,
        domain,
        types: KEELSON_TYPES,
        primaryType: "Countersign",
        message,
      }),
    ).toBe(expected.signature);
  });

  test("matches hashTypedData", () => {
    const domain = keelsonDomain(CHAIN_IDS.arbitrumSepolia, verifyingContract);
    const message = parseCountersign(countersignVectors[0]?.input.message ?? {});
    expect(countersignDigest(message, domain)).toBe(
      hashTypedData({ domain, types: KEELSON_TYPES, primaryType: "Countersign", message }),
    );
  });

  test("rejects a domain on an unsupported chain", () => {
    const message = parseCountersign(countersignVectors[0]?.input.message ?? {});
    const domain = { name: "Keelson", version: "1", chainId: 1, verifyingContract };
    expect(() => countersignDigest(message, domain)).toThrow(RangeError);
  });

  test("rejects an out-of-range uint40", () => {
    const domain = keelsonDomain(CHAIN_IDS.arbitrumSepolia, verifyingContract);
    const message = parseCountersign(countersignVectors[0]?.input.message ?? {});
    expect(() => countersignDigest({ ...message, issuedAt: 2 ** 40 }, domain)).toThrow(RangeError);
  });
});

describe("reportData", () => {
  test.each(reportDataVectors)("matches the golden vector $name", ({ input, expected }) => {
    const binding = {
      ...input.binding,
      chainId: BigInt(input.binding.chainId),
      bootEpoch: BigInt(input.binding.bootEpoch),
    } as SignerBinding;
    if (expected === "error") {
      expect(() => reportData(binding, input.blockHash as Hex)).toThrow(RangeError);
    } else {
      expect(reportData(binding, input.blockHash as Hex)).toBe(expected);
    }
  });

  test("is 64 bytes ending in the block hash", () => {
    const blockHash = word(0xabcdef);
    const binding: SignerBinding = {
      chainId: 421614n,
      bondVault: verifyingContract,
      teeKind: TeeKind.TDX,
      signer: verifyingContract,
      policySetHash: word(1),
      engineBuildId: word(2),
      bootEpoch: 1n,
      issuerJwkThumbprint: word(3),
    };
    const data = reportData(binding, blockHash);
    expect(data).toHaveLength(2 + 128);
    expect(data.slice(66)).toBe(blockHash.slice(2));
    expect(reportData({ ...binding, issuerJwkThumbprint: word(4) }, blockHash)).not.toBe(data);
  });
});

describe("failedFieldsMask", () => {
  test.each(maskVectors)("matches the golden vector $name", ({ input, expected }) => {
    expect(failedFieldsMask(input.fired, input)).toBe(expected);
  });

  test("sets the extra bit for any fired policy outside the base table", () => {
    expect(failedFieldsMask(["amount", "extra.0"], {})).toBe((1 << 3) | (1 << BIT_EXTRA));
    expect(failedFieldsMask(["base"], {})).toBe(0);
  });
});

function parseCountersign(raw: Record<string, string>): Countersign {
  return Object.fromEntries(
    KEELSON_TYPES.Countersign.map(({ name, type }) => {
      const value = raw[name] as string;
      if (type === "uint256" || type === "uint64") return [name, BigInt(value)];
      return [name, type.startsWith("uint") ? Number(value) : value];
    }),
  ) as unknown as Countersign;
}
