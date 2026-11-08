import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Countersign } from "@keelson/core/eip712";
import {
  type Address,
  concat,
  createTestClient,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  http,
  keccak256,
  publicActions,
  stringToHex,
  walletActions,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { keelsonBondVaultAbi } from "../src/abis.ts";
import { addresses } from "../src/addresses.ts";
import {
  type CountersignMode,
  type Coverage,
  coverageTypedData,
  lockCoverageArgs,
  toAssertion,
  userKeyHash,
} from "../src/coverage.ts";

const contracts = new URL("../../../contracts/", import.meta.url);
const read = (path: string) => JSON.parse(readFileSync(new URL(path, contracts), "utf8"));
const registry = read("deployments/421614.json");
const FORK_BLOCK = 327_231_200n;
const PORT = 18_614;
const live = process.env.KEELSON_LIVE === "1";

interface Vector {
  countersign: Record<string, string>;
  hSd: Hex;
  mode: CountersignMode;
  signatures: { tdx: Hex; nitro: Hex | null };
  assertion: { authenticatorData: string; clientDataJSON: string; signature: string };
  encodedAssertion: { r: Hex; s: Hex; challengeIndex: number; typeIndex: number };
  qx: Hex;
  qy: Hex;
}

const vectors = ["coverage-2of2-webauthn", "coverage-2of2-payment", "coverage-degraded"].map(
  (name) => [name, read(`test/vectors/${name}.json`) as Vector] as const,
);

const b64u = (hex: Hex) => Buffer.from(hex.slice(2), "hex").toString("base64url");
const jwk = (v: Vector) => ({ kty: "EC", crv: "P-256", x: b64u(v.qx), y: b64u(v.qy) });
const countersign = (v: Vector) =>
  Object.fromEntries(
    Object.entries(v.countersign).map(([k, x]) => [k, x.startsWith("0x") ? x : BigInt(x)]),
  ) as unknown as Countersign;

describe("lockCoverageArgs", () => {
  test.each(vectors)("encodes %s as the contract tests do", (_, v) => {
    const args = lockCoverageArgs({
      coverage: {} as Coverage,
      countersign: countersign(v),
      hSd: v.hSd,
      assertion: v.assertion,
      publicKeyJwk: jwk(v),
      operatorSig: "0x",
      mode: v.mode,
      signatures: v.signatures,
    });
    const a = args[3];
    expect([a.r, a.s, Number(a.challengeIndex), Number(a.typeIndex)]).toEqual([
      v.encodedAssertion.r,
      v.encodedAssertion.s,
      v.encodedAssertion.challengeIndex,
      v.encodedAssertion.typeIndex,
    ]);
    expect([args[4], args[5]]).toEqual([v.qx, v.qy]);
    expect(args[7].length).toBe(v.mode === "2of2" ? 2 + 260 : 2 + 130);
  });
});

/** The vault deployed on an anvil fork of Arbitrum Sepolia, funded with the funders' faucet PYUSD. */
describe.skipIf(!live)("lockCoverage on an anvil fork", { timeout: 120_000 }, () => {
  let anvil: ChildProcess;
  const client = createTestClient({
    chain: arbitrumSepolia,
    mode: "anvil",
    transport: http(`http://127.0.0.1:${PORT}`),
  })
    .extend(publicActions)
    .extend(walletActions);
  let vault: Address;
  const deployer = privateKeyToAccount(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  );
  const operator = () => privateKeyToAccount(process.env.KEELSON_OPERATOR_KEY as Hex);
  const pyusd = registry.external.pyusd as Address;
  const agentId = BigInt(registry.demo.agentId);

  beforeAll(async () => {
    anvil = spawn("anvil", [
      "--fork-url",
      process.env.ARBITRUM_SEPOLIA_RPC_URL as string,
      "--fork-block-number",
      FORK_BLOCK.toString(),
      "--port",
      String(PORT),
      "--hardfork",
      "osaka",
      "--silent",
    ]);
    for (let i = 0; ; i++) {
      try {
        await client.getChainId();
        break;
      } catch (e) {
        if (i > 100) throw e;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    const artifact = read("out/KeelsonBondVault.sol/KeelsonBondVault.json");
    const a = addresses[421614];
    const hash = await client.deployContract({
      account: deployer,
      abi: keelsonBondVaultAbi,
      bytecode: artifact.bytecode.object,
      args: [
        pyusd,
        a.VerdictVerifier as Address,
        a.CheckpointAnchor as Address,
        registry.external.erc8004Identity,
        "0xd10Cb524B3C5EC3c60A420e8900e4f8C5aB88972",
        keccak256(stringToHex(registry.params.logOrigin)),
        `0x${createHash("sha256").update("keelson.finance").digest("hex")}`,
        a.AccessManager as Address,
        {
          disputeWindow: registry.params.disputeWindow,
          vetoWindow: registry.params.vetoWindow,
          grace: registry.params.grace,
          withdrawalDelay: registry.params.withdrawalDelay,
          instantSlashCap: BigInt(registry.params.instantSlashCap),
        },
        registry.params.slashRateWindow,
        BigInt(registry.params.slashRateCapacity),
      ],
    });
    vault = (await client.waitForTransactionReceipt({ hash })).contractAddress as Address;

    const domain = await client.readContract({
      address: pyusd,
      abi: [
        {
          name: "DOMAIN_SEPARATOR",
          type: "function",
          stateMutability: "view",
          inputs: [],
          outputs: [{ type: "bytes32" }],
        },
      ],
      functionName: "DOMAIN_SEPARATOR",
    });
    const typehash = keccak256(
      stringToHex(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
      ),
    );
    const balanceOf = [
      {
        name: "balanceOf",
        type: "function",
        stateMutability: "view",
        inputs: [{ type: "address" }],
        outputs: [{ type: "uint256" }],
      },
    ] as const;
    for (const [i, key] of (process.env.KEELSON_FUNDER_KEYS as string).split(",").entries()) {
      const funder = privateKeyToAccount(key as Hex);
      const value = await client.readContract({
        address: pyusd,
        abi: balanceOf,
        functionName: "balanceOf",
        args: [funder.address],
      });
      const salt = `0x${(i + 1).toString(16).padStart(64, "0")}` as Hex;
      const nonce = keccak256(
        encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [agentId, salt]),
      );
      const max = 2n ** 256n - 1n;
      const structHash = keccak256(
        encodeAbiParameters(
          [
            { type: "bytes32" },
            { type: "address" },
            { type: "address" },
            { type: "uint256" },
            { type: "uint256" },
            { type: "uint256" },
            { type: "bytes32" },
          ],
          [typehash, funder.address, vault, value, 0n, max, nonce],
        ),
      );
      const signature = await funder.sign({
        hash: keccak256(concat(["0x1901", domain, structHash])),
      });
      await client.writeContract({
        account: deployer,
        address: vault,
        abi: keelsonBondVaultAbi,
        functionName: "depositWithAuthorization",
        args: [agentId, funder.address, value, 0n, max, salt, signature],
      });
    }

    // After every vector's issue time and before any expires.
    const issued = Math.max(...vectors.map(([, v]) => Number(v.countersign.issuedAt)));
    await client.setNextBlockTimestamp({ timestamp: BigInt(issued) });
    await client.mine({ blocks: 1 });
  }, 120_000);

  afterAll(() => {
    anvil?.kill();
  });

  test.each(vectors)("the args of %s lock its coverage", async (_, v) => {
    const cs = countersign(v);
    const amount = BigInt(cs.amount) * 10_000n;
    const coverage: Coverage = {
      coverageId: cs.requestId,
      agentId,
      merchant: registry.demo.merchant,
      amount,
      premium: amount / 100n,
      expiresAt: Number(cs.issuedAt) + registry.params.disputeWindow,
      mandateHash: cs.mandateHash,
      amberCommitment: keccak256(stringToHex(`amber/${cs.requestId}`)),
      userKeyHash: userKeyHash(v.qx, v.qy),
    };
    const operatorSig = await operator().signTypedData(coverageTypedData(coverage, 421614, vault));
    const data = encodeFunctionData({
      abi: keelsonBondVaultAbi,
      functionName: "lockCoverage",
      args: lockCoverageArgs({
        coverage,
        countersign: cs,
        hSd: v.hSd,
        assertion: v.assertion,
        publicKeyJwk: jwk(v),
        operatorSig,
        mode: v.mode,
        signatures: v.signatures,
      }),
    });
    await expect(client.call({ to: vault, data })).resolves.toBeDefined();
    expect(toAssertion(v.assertion).s).toBe(v.encodedAssertion.s);
  });
});
