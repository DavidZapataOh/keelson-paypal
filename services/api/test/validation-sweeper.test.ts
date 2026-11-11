import { randomBytes } from "node:crypto";
import { keelsonReputationReporterAbi, keelsonValidationRegistryAbi } from "@keelson/chain";
import { KEELSON_TYPES, keelsonDomain } from "@keelson/core/eip712";
import { eq, mandates, operators, purchases, teeSignatures, teeSigners, user } from "@keelson/db";
import { createRelayer, type Relayer } from "@keelson/relayer";
import { pino } from "pino";
import { ulid } from "ulid";
import {
  decodeFunctionData,
  type Hex,
  hashTypedData,
  hexToBytes,
  type PublicClient,
  recoverAddress,
  slice,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ANVIL_KEY, type Fork, startFork } from "../../../packages/relayer/test/fork.ts";
import { ingestReceipt } from "../src/chain/events.ts";
import { recordOutcomes, recordValidations, type SweeperDeps } from "../src/onchain/validations.ts";
import { VERIFYING_CONTRACT } from "../src/tee/config.ts";
import { testDb } from "./setup.ts";

const rpc = process.env.ARBITRUM_SEPOLIA_RPC_URL;
/** The demo operator's first live `recordCountersign`; the fork starts one block before it. */
const RECORD_TX: Hex = "0x960ae0b322e8207cba6c7f2ffeef4dd79382df2f8e9531089a48ddffbe81073a";
const BLOCK = 327_281_616n;
const REGISTRY = "0x2405d211CaAdFbB193287882fAb76e8A5D41f714" as const;
const REPORTER = "0x0D736293957C481626553Bec31e46913A21FBc25" as const;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const bytes = (h: Hex) => Buffer.from(hexToBytes(h));

function ulidOf(id: Hex): string {
  let n = BigInt(id);
  let out = "";
  for (let i = 0; i < 26; i++) {
    out = ALPHABET[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

describe.skipIf(!rpc)(
  "the validation sweeper on an anvil fork of Arbitrum Sepolia",
  { timeout: 120_000 },
  () => {
    let fork: Fork;
    let relayer: Relayer;
    let deps: SweeperDeps;
    let coverageId: Hex;
    let digest: Hex;
    let purchaseId: string;

    beforeAll(async () => {
      fork = await startFork(8612, BLOCK);
      relayer = createRelayer({
        db: testDb,
        log: pino({ level: "silent" }),
        chains: {
          421614: {
            rpcUrl: fork.url,
            sequencerUrl: fork.url,
            account: privateKeyToAccount(ANVIL_KEY),
          },
        },
      });
      const client = fork.client as unknown as PublicClient;
      deps = {
        db: testDb,
        log: pino({ level: "silent" }),
        relayer,
        chain: { client },
      };

      // The real countersign and the legs' real signatures, from the transaction that first recorded them.
      const tx = await fork.client.getTransaction({ hash: RECORD_TX });
      const call = decodeFunctionData({ abi: keelsonValidationRegistryAbi, data: tx.input });
      if (call.functionName !== "recordCountersign") throw new Error("not a recordCountersign");
      const [c, sigs] = call.args;
      coverageId = c.requestId;
      digest = hashTypedData({
        domain: keelsonDomain(421614, VERIFYING_CONTRACT),
        types: KEELSON_TYPES,
        primaryType: "Countersign",
        message: c,
      });
      purchaseId = ulidOf(coverageId);
      const countersign = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, String(v)]));

      const userId = ulid();
      await testDb
        .insert(user)
        .values({ id: userId, name: "Buyer", email: `${userId}@example.com` });
      const agentId = BigInt(`0x${randomBytes(6).toString("hex")}`);
      await testDb.insert(operators).values({
        agentId,
        chainId: 421614,
        agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
        name: "Operator",
        cnfJwk: {},
      });
      const mandateId = ulid();
      await testDb.insert(mandates).values({
        id: mandateId,
        userId,
        operatorAgentId: agentId,
        currency: "USD",
        maxMinor: 10_000n,
        remainingMinor: 10_000n,
        merchantIds: ["merchant"],
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      await testDb.insert(purchases).values({
        id: purchaseId,
        mandateId,
        state: "COVERED",
        merchantId: "merchant",
        currency: "USD",
        amountMinor: BigInt(countersign.amount as string),
        cartHash: bytes(c.cartHash),
        countersignDigest: bytes(digest),
        countersign,
        decision: 1,
        countersignMode: "2of2",
      });
      for (const [kind, signature] of [
        [1, slice(sigs, 0, 65)],
        [2, slice(sigs, 65)],
      ] as const) {
        const signer = await recoverAddress({ hash: digest, signature });
        await testDb
          .insert(teeSigners)
          .values({
            address: bytes(signer),
            teeKind: kind,
            measurement: "live",
            binding: {},
            attestation: {},
            expiresAt: new Date(Date.now() + 3_600_000),
            revokedAt: new Date(),
          })
          .onConflictDoNothing();
        await testDb.insert(teeSignatures).values({
          requestId: purchaseId,
          signer: bytes(signer),
          digest: bytes(digest),
          signature: bytes(signature),
        });
      }
    });
    afterAll(() => fork?.stop());

    test("a covered purchase gets its validation once", async () => {
      expect(await recordValidations(deps)).toBe(1);
      const [row] = await testDb.select().from(purchases).where(eq(purchases.id, purchaseId));
      expect(row?.validationTxId).toBeTruthy();
      const record = await relayer.getById(row?.validationTxId as string);
      expect(record).toMatchObject({
        status: "confirmed",
        key: `KeelsonValidationRegistry.recordCountersign:${digest}`,
      });
      const [, , response, , tag] = await fork.client.readContract({
        address: REGISTRY,
        abi: keelsonValidationRegistryAbi,
        functionName: "getValidationStatus",
        args: [digest],
      });
      expect([response, tag]).toEqual([100, "2of2"]);
      expect(await recordValidations(deps)).toBe(0);
    });

    test("a released coverage is rated and its validation settled once", async () => {
      await fork.client.increaseTime({ seconds: 7 * 24 * 3600 });
      await fork.client.mine({ blocks: 1 });
      const release = await relayer.submit({
        chainId: 421614,
        contract: "KeelsonBondVault",
        functionName: "releaseCoverage",
        args: [coverageId],
        key: `KeelsonBondVault.releaseCoverage:${coverageId}`,
      });
      expect(release.status).toBe("confirmed");
      // The event as the subscription stores it, twice: the second copy is the same row.
      const receipt = await fork.client.getTransactionReceipt({ hash: release.hash as Hex });
      expect(await ingestReceipt(testDb, receipt)).toHaveLength(1);
      expect(await ingestReceipt(testDb, receipt)).toHaveLength(0);
      expect(await recordOutcomes(deps)).toBe(2);
      expect(
        await fork.client.readContract({
          address: REPORTER,
          abi: keelsonReputationReporterAbi,
          functionName: "rated",
          args: [coverageId],
        }),
      ).toBe(true);
      expect(
        await fork.client.readContract({
          address: REGISTRY,
          abi: keelsonValidationRegistryAbi,
          functionName: "outcomeRecorded",
          args: [coverageId],
        }),
      ).toBe(true);
      const [, , response, , tag] = await fork.client.readContract({
        address: REGISTRY,
        abi: keelsonValidationRegistryAbi,
        functionName: "getValidationStatus",
        args: [digest],
      });
      expect([response, tag]).toEqual([100, "settled"]);
      expect(await recordOutcomes(deps)).toBe(0);
    });
  },
);
