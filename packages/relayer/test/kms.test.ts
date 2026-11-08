import { randomBytes } from "node:crypto";
import { GetPublicKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  bytesToHex,
  getAddress,
  keccak256,
  parseSignature,
  parseTransaction,
  recoverAddress,
  recoverTransactionAddress,
  verifyTypedData,
} from "viem";
import { arbitrumSepolia } from "viem/chains";
import { beforeAll, describe, expect, test } from "vitest";
import { KmsError, kmsAccount } from "../src/kms.ts";
import { kms } from "./env.ts";

const HALF_N = secp256k1.Point.CURVE().n / 2n;

describe.skipIf(!kms)("kmsAccount (real KMS, sandbox key)", () => {
  const { client, keyId } = kms ?? ({} as NonNullable<typeof kms>);
  let account: Awaited<ReturnType<typeof kmsAccount>>;

  beforeAll(async () => {
    account = await kmsAccount({ keyId, client });
  });

  test("the address is keccak256 of the KMS public key", async () => {
    const { PublicKey } = await client.send(new GetPublicKeyCommand({ KeyId: keyId }));
    const point = (PublicKey as Uint8Array).subarray(-64);
    expect(account.address).toBe(getAddress(`0x${keccak256(point).slice(-40)}`));
    expect(account.source).toBe("kms");
  });

  test("1,000 signatures are low-S and recover to the address", { timeout: 300_000 }, async () => {
    const latencies: number[] = [];
    const run = async () => {
      const hash = bytesToHex(randomBytes(32));
      const started = performance.now();
      const signature = await account.sign?.({ hash });
      latencies.push(performance.now() - started);
      if (!signature) throw new Error("no signature");
      const { s } = parseSignature(signature);
      expect(BigInt(s) <= HALF_N).toBe(true);
      expect(await recoverAddress({ hash, signature })).toBe(account.address);
    };
    for (let i = 0; i < 1_000; i += 20) {
      await Promise.all(Array.from({ length: 20 }, run));
    }
    latencies.sort((a, b) => a - b);
    const p = (q: number) => Math.round(latencies[Math.floor(q * (latencies.length - 1))] ?? 0);
    console.info(`kms sign round trip p50 ${p(0.5)} ms p95 ${p(0.95)} ms (20 in flight)`);
  });

  test("typed data verifies", async () => {
    const typedData = {
      domain: { name: "Keelson", version: "1", chainId: 421614 },
      types: { Ping: [{ name: "n", type: "uint256" }] },
      primaryType: "Ping",
      message: { n: 7n },
    } as const;
    const signature = await account.signTypedData(typedData);
    expect(await verifyTypedData({ ...typedData, address: account.address, signature })).toBe(true);
  });

  test("an EIP-1559 transaction for Arbitrum Sepolia recovers to the address", async () => {
    const serialized = await account.signTransaction({
      chainId: arbitrumSepolia.id,
      type: "eip1559",
      nonce: 3,
      to: account.address,
      value: 1n,
      gas: 21_000n,
      maxFeePerGas: 40_000_000n,
      maxPriorityFeePerGas: 0n,
    });
    const tx = parseTransaction(serialized);
    expect(tx.chainId).toBe(arbitrumSepolia.id);
    expect(await recoverTransactionAddress({ serializedTransaction: serialized })).toBe(
      account.address,
    );
  });

  test("a key the relayer may not use is refused", async () => {
    const other = new KMSClient({
      region: kms?.region ?? "us-west-2",
      ...(kms?.credentials ? { credentials: kms.credentials } : {}),
    });
    await expect(kmsAccount({ keyId: "alias/aws/s3", client: other })).rejects.toSatisfy(
      (err) => err instanceof KmsError && (err.cause as Error).name === "AccessDeniedException",
    );
  });
});
