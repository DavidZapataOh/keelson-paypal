import { randomBytes } from "node:crypto";
import { addresses, checkpointAnchorAbi, iPYUSDAbi, keelsonBondVaultAbi } from "@keelson/chain";
import { KEELSON_TYPES, keelsonDomain } from "@keelson/core/eip712";
import {
  chainTxs,
  disputes,
  eq,
  mandates,
  merchantSettlement,
  operators,
  purchases,
  user,
  verdicts,
} from "@keelson/db";
import { reputationRegistryAbi } from "@keelson/erc8004";
import { createRelayer, EXTERNAL } from "@keelson/relayer";
import { pino } from "pino";
import { ulid } from "ulid";
import {
  encodeAbiParameters,
  type Hex,
  hashTypedData,
  hexToBytes,
  keccak256,
  numberToHex,
  type PublicClient,
  pad,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ANVIL_KEY, type Fork, PYUSD, startFork } from "../../../packages/relayer/test/fork.ts";
import { createApp } from "../src/app.ts";
import { resumeSettlements, type SettleDeps, settleDispute } from "../src/disputes/settle.ts";
import { KEELSON_TREASURY, SETTLEMENT } from "../src/merchants.ts";
import { createPayPalDeps } from "../src/paypal.ts";
import { loadMeasurements } from "../src/tee/measurements.ts";
import { testDb, testKv } from "./setup.ts";

const rpc = process.env.ARBITRUM_SEPOLIA_RPC_URL;
const chain = addresses[421614];
/** One block after the live `lockCoverage` of a 2 PYUSD, 2-of-2 coverage of agent 351; it stays slashable for 11 minutes. */
const BLOCK = 327_682_892n;
const COVERAGE: Hex = "0x0000000000000000000000000000000001a1c26a4ab70535ee8599dd9bfe99be";
const AGENT_ID = 351n;
/** The published TDX and Nitro measurements, which the `VerdictVerifier` allows at `BLOCK`. */
const measurementOf = (id: string) => `0x${id.split(":")[1]}` as Hex;
const published = loadMeasurements();
const TDX_MEASUREMENT = measurementOf(published.tdx[0] as string);
const NITRO_MEASUREMENT = measurementOf(published.nitro[0] as string);
/** `forge inspect VerdictVerifier storageLayout`: `measurementIds` and `signers`. */
const MEASUREMENT_IDS_SLOT = 4n;
const SIGNERS_SLOT = 7n;
const LOG_ORIGIN: Hex = "0xe0c0e434acc96fa35fb684556f51efd752a89b3db13536efbf1e4a0d85e800d9";
const merchant = SETTLEMENT.mrc_runfast as Hex;
/** A sandbox personal account: PayPal refuses a payout to the account that sends it. */
const receiver = process.env.PAYPAL_SANDBOX_PERSONAL_EMAIL;
/** Holds PYUSD at `BLOCK` (`contracts/deployments/421614.json`); it funds the fork's treasury. */
const PYUSD_HOLDER: Hex = "0xcc9644EC26A647de0B9b86f1560d5180232f70a3";

const slotOf = (key: Hex, keyType: "address" | "bytes32", slot: bigint) =>
  keccak256(encodeAbiParameters([{ type: keyType }, { type: "uint256" }], [key, slot]));

describe.skipIf(!rpc)(
  "settling verdicts on an anvil fork of Arbitrum Sepolia",
  { timeout: 300_000 },
  () => {
    let fork: Fork;
    let deps: SettleDeps;
    let client: PublicClient;
    let purchaseId: string;
    let mandateId: string;
    let treeSize: bigint;
    let checkpointRoot: Hex;
    const tdx = privateKeyToAccount(generatePrivateKey());
    const nitro = privateKeyToAccount(generatePrivateKey());

    /**
     * The two fork-only verdict signers, written where `VerdictVerifier` keeps registered signers:
     * registering a key needs a TEE quote that only a key born inside the TEE can carry.
     */
    async function installSigners() {
      const now = (await client.getBlock()).timestamp;
      for (const [signer, kind, measurement] of [
        [tdx.address, 1n, TDX_MEASUREMENT],
        [nitro.address, 2n, NITRO_MEASUREMENT],
      ] as const) {
        const id = BigInt(
          (await client.getStorageAt({
            address: chain.VerdictVerifier as Hex,
            slot: slotOf(measurement, "bytes32", MEASUREMENT_IDS_SLOT),
          })) ?? "0x0",
        );
        expect(id).toBeGreaterThan(0n);
        const slot = slotOf(signer, "address", SIGNERS_SLOT);
        const packed = kind | (now << 8n) | ((2n ** 40n - 1n) << 48n) | (id << 128n);
        await fork.client.setStorageAt({
          address: chain.VerdictVerifier as Hex,
          index: slot,
          value: pad(numberToHex(packed)),
        });
        await fork.client.setStorageAt({
          address: chain.VerdictVerifier as Hex,
          index: numberToHex(BigInt(slot) + 1n, { size: 32 }),
          value: measurement,
        });
      }
    }

    /** Stores a verdict both fork signers (or the TDX one alone) signed, as the dispute workflow does. */
    async function storeVerdict(opts: {
      liable: 1 | 2;
      amount: bigint;
      payee: Hex;
      rail?: "pyusd" | "paypal";
      degraded?: boolean;
      deadline?: number;
      purchase?: string;
    }): Promise<string> {
      const disputeId = `PP-R-${randomBytes(5).toString("hex").toUpperCase()}`;
      const now = Number((await client.getBlock()).timestamp);
      const message = {
        disputeId: keccak256(`0x${Buffer.from(disputeId).toString("hex")}${COVERAGE.slice(2)}`),
        coverageId: COVERAGE,
        agentId: AGENT_ID,
        payee: opts.payee,
        amount: opts.amount,
        ruleId: opts.liable === 1 ? 61 : 60,
        liable: opts.liable,
        fieldId: 9,
        evidenceHash: keccak256(randomBytes(32)),
        inputsHash: keccak256(randomBytes(32)),
        policySetHash: keccak256(randomBytes(32)),
        checkpointRoot,
        issuedAt: now,
        deadline: opts.deadline ?? now + 3_600,
      };
      const typed = {
        domain: keelsonDomain(421614, chain.VerdictVerifier as Hex),
        types: KEELSON_TYPES,
        primaryType: "Verdict" as const,
        message,
      };
      const digest = hashTypedData(typed);
      const signatures = [
        { tee: 1, signer: tdx.address, signature: await tdx.signTypedData(typed) },
      ];
      if (!opts.degraded) {
        signatures.push({
          tee: 2,
          signer: nitro.address,
          signature: await nitro.signTypedData(typed),
        });
      }
      await testDb.insert(disputes).values({
        id: disputeId,
        purchaseId: opts.purchase ?? purchaseId,
        reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
        raw: {},
        state: "ATTRIBUTED",
      });
      await testDb.insert(verdicts).values({
        id: ulid(),
        disputeId,
        liable: opts.liable,
        ruleId: message.ruleId,
        amountMinor: opts.amount / 10_000n,
        currency: "USD",
        payee: opts.payee,
        rail: opts.rail ?? "pyusd",
        digest: Buffer.from(hexToBytes(digest)),
        chainId: 421614,
        message: Object.fromEntries(Object.entries(message).map(([k, v]) => [k, String(v)])),
        signatures,
        facts: {},
      });
      return disputeId;
    }

    const balance = (who: Hex) =>
      client.readContract({
        address: PYUSD,
        abi: iPYUSDAbi,
        functionName: "balanceOf",
        args: [who],
      });
    const txsFor = async (disputeId: string) => {
      const [v] = await testDb.select().from(verdicts).where(eq(verdicts.disputeId, disputeId));
      const onChainId = (v?.message as Record<string, string> | undefined)?.disputeId ?? "";
      return (await testDb.select().from(chainTxs)).filter((t) => t.key.endsWith(onChainId));
    };

    beforeAll(async () => {
      fork = await startFork(8613, BLOCK);
      client = fork.client as unknown as PublicClient;
      const relayer = createRelayer({
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
      deps = { db: testDb, log: pino({ level: "silent" }), relayer, chain: { client } };
      await installSigners();
      [treeSize, checkpointRoot] = await client.readContract({
        address: chain.CheckpointAnchor as Hex,
        abi: checkpointAnchorAbi,
        functionName: "latest",
        args: [LOG_ORIGIN],
      });

      const userId = ulid();
      await testDb
        .insert(user)
        .values({ id: userId, name: "Tester", email: `${userId}@example.test` });
      const agentId = BigInt(Date.now());
      await testDb.insert(operators).values({
        agentId,
        chainId: 421614,
        agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
        name: "op",
        cnfJwk: {},
      });
      mandateId = ulid();
      await testDb.insert(mandates).values({
        id: mandateId,
        userId,
        operatorAgentId: agentId,
        currency: "USD",
        maxMinor: 2_000n,
        remainingMinor: 2_000n,
        merchantIds: ["mrc_runfast"],
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      purchaseId = await newPurchase();
    });

    /** An attributed purchase covered by `COVERAGE`, anchored in the log. */
    async function newPurchase(): Promise<string> {
      const id = ulid();
      await testDb.insert(purchases).values({
        id,
        mandateId,
        merchantId: "mrc_runfast",
        currency: "USD",
        amountMinor: 100n,
        cartHash: randomBytes(32),
        state: "ATTRIBUTED",
        anchoredSize: treeSize,
        chainId: 421614,
      });
      return id;
    }
    afterAll(() => fork?.stop());

    test("an amber verdict slashes the operator's bond to the merchant, once", async () => {
      const before = await balance(merchant);
      const id = await storeVerdict({ liable: 1, amount: 400_000n, payee: merchant });
      const started = performance.now();
      const out = await settleDispute(deps, id);
      const elapsed = Math.round(performance.now() - started);
      expect(out).toMatchObject({ status: "settled", outcome: "paid" });
      expect((await balance(merchant)) - before).toBe(400_000n);
      const [p] = await testDb.select().from(purchases).where(eq(purchases.id, purchaseId));
      expect(p?.state).toBe("SLASHED");

      expect(await settleDispute(deps, id)).toMatchObject({ status: "settled", outcome: "paid" });
      const txs = await txsFor(id);
      expect(txs).toHaveLength(1);
      console.info(`slash: settled in ${elapsed} ms, gas ${txs[0]?.gasUsed}`);

      const res = await createApp({ db: testDb, kv: testKv, log: deps.log }).request(
        `/v1/disputes/${id}`,
      );
      const body = (await res.json()) as { settlement: Record<string, unknown> };
      expect(body.settlement).toMatchObject({ rail: "pyusd", outcome: "paid", refund_id: null });
      expect(body.settlement.explorer_url).toMatch(/^https:\/\/sepolia\.arbiscan\.io\/tx\/0x/);
    });

    test("a green verdict on the paypal rail pays the treasury from the reserve and waits for the payout", async () => {
      const before = await balance(KEELSON_TREASURY);
      const id = await storeVerdict({
        liable: 2,
        amount: 300_000n,
        payee: KEELSON_TREASURY,
        rail: "paypal",
      });
      const started = performance.now();
      expect(await settleDispute(deps, id)).toEqual({
        status: "pending",
        disputeId: id,
        waiting: "payout",
      });
      const elapsed = Math.round(performance.now() - started);
      expect((await balance(KEELSON_TREASURY)) - before).toBe(300_000n);
      const [v] = await testDb.select().from(verdicts).where(eq(verdicts.disputeId, id));
      expect(v?.outcome).toBe("paid");
      console.info(`payWarranty: settled in ${elapsed} ms, gas ${(await txsFor(id))[0]?.gasUsed}`);
    });

    test.skipIf(!receiver || !process.env.PAYPAL_CLIENT_ID)(
      "the paypal rail then pays the merchant a sandbox Payout under the verdict's reference",
      async () => {
        const id = await storeVerdict({
          liable: 2,
          amount: 100_000n,
          payee: KEELSON_TREASURY,
          rail: "paypal",
        });
        await testDb
          .insert(merchantSettlement)
          .values({ merchantId: "mrc_runfast", rail: "paypal", paypalReceiver: receiver })
          .onConflictDoUpdate({
            target: merchantSettlement.merchantId,
            set: { rail: "paypal", paypalReceiver: receiver },
          });
        const live: SettleDeps = {
          ...deps,
          paypal: createPayPalDeps({
            PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID as string,
            PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET as string,
            PAYPAL_ENV: "sandbox",
            PAYPAL_MERCHANT_ID: "A4WCRYD5EYDF2",
          }),
        };
        const started = performance.now();
        let out = await settleDispute(live, id);
        while (out.status === "pending" && performance.now() - started < 120_000) {
          await new Promise((r) => setTimeout(r, 3_000));
          out = await settleDispute(live, id);
        }
        expect(out).toMatchObject({ status: "settled", outcome: "paid" });
        const [v] = await testDb.select().from(verdicts).where(eq(verdicts.disputeId, id));
        expect(v?.payoutStatus).toBe("SUCCESS");
        console.info(
          `payout ${v?.payoutBatchId}: verdict to SUCCESS in ${Math.round(performance.now() - started)} ms`,
        );
        await testDb.delete(merchantSettlement);
      },
      180_000,
    );

    test("an expired verdict fails once and is not sent again", async () => {
      const now = Number((await client.getBlock()).timestamp);
      const id = await storeVerdict({
        liable: 1,
        amount: 1_000n,
        payee: merchant,
        deadline: now - 1,
      });
      expect(await settleDispute(deps, id)).toEqual({
        status: "failed",
        disputeId: id,
        failure: "Expired",
      });
      expect(await settleDispute(deps, id)).toMatchObject({ status: "failed", failure: "Expired" });
    });

    describe("when the chain refuses a verdict that holds", () => {
      /** A treasury of the fork's own, funded from a PYUSD holder: its key signs the transfers. */
      const treasury = privateKeyToAccount(generatePrivateKey());
      let paying: SettleDeps;
      const feedback = () =>
        client.readContract({
          address: EXTERNAL[421614].ReputationRegistry,
          abi: reputationRegistryAbi,
          functionName: "getSummary",
          args: [AGENT_ID, [privateKeyToAccount(ANVIL_KEY).address], "keelson", "uncollected"],
        });

      beforeAll(async () => {
        paying = { ...deps, treasury };
        await fork.client.impersonateAccount({ address: PYUSD_HOLDER });
        await fork.client.setBalance({ address: PYUSD_HOLDER, value: 10n ** 18n });
        const funded = await fork.client.writeContract({
          account: PYUSD_HOLDER,
          chain: null,
          address: PYUSD,
          abi: iPYUSDAbi,
          functionName: "transfer",
          args: [treasury.address, 500_000n],
        });
        await fork.client.waitForTransactionReceipt({ hash: funded });
        await fork.client.stopImpersonatingAccount({ address: PYUSD_HOLDER });
      });

      test("the treasury pays an operator's expired verdict in PYUSD, once, and rates the fault on ERC-8004", async () => {
        const purchase = await newPurchase();
        const now = Number((await client.getBlock()).timestamp);
        const id = await storeVerdict({
          liable: 1,
          amount: 100_000n,
          payee: merchant,
          deadline: now - 1,
          purchase,
        });
        const [merchantBefore, treasuryBefore, [faultsBefore]] = await Promise.all([
          balance(merchant),
          balance(treasury.address),
          feedback(),
        ]);
        const started = performance.now();
        const out = await settleDispute(paying, id);
        const elapsed = Math.round(performance.now() - started);
        expect(out).toMatchObject({ status: "settled", disputeId: id, outcome: "paid" });
        expect((await balance(merchant)) - merchantBefore).toBe(100_000n);
        expect(treasuryBefore - (await balance(treasury.address))).toBe(100_000n);
        const [count, value, decimals] = await feedback();
        expect(count).toBe(faultsBefore + 1n);
        expect([value, decimals]).toEqual([-100n, 2]);
        const [v] = await testDb.select().from(verdicts).where(eq(verdicts.disputeId, id));
        expect(v).toMatchObject({ outcome: "paid", paidBy: "treasury", failure: "Expired" });
        const [p] = await testDb.select().from(purchases).where(eq(purchases.id, purchase));
        expect(p?.state).toBe("WARRANTY_PAID");

        expect(await settleDispute(paying, id)).toEqual(out);
        expect((await balance(merchant)) - merchantBefore).toBe(100_000n);
        expect((await feedback())[0]).toBe(faultsBefore + 1n);
        const txs = await txsFor(id);
        expect(txs.map((t) => `${t.contract}.${t.function}:${t.status}`).sort()).toEqual([
          "KeelsonBondVault.slash:rejected",
          "PYUSD.transferWithAuthorization:confirmed",
          "ReputationRegistry.giveFeedback:confirmed",
        ]);
        const transfer = txs.find((t) => t.contract === "PYUSD");
        console.info(`treasury transfer: settled in ${elapsed} ms, gas ${transfer?.gasUsed}`);

        const res = await createApp({ db: testDb, kv: testKv, log: deps.log }).request(
          `/v1/disputes/${id}`,
        );
        const body = (await res.json()) as { settlement: Record<string, unknown> };
        expect(body.settlement).toMatchObject({
          rail: "pyusd",
          outcome: "paid",
          paid_by: "treasury",
          failure: "Expired",
          tx_hash: `0x${Buffer.from(transfer?.hash as Buffer).toString("hex")}`,
        });
      });

      test("Keelson's own refused warranty is paid by the treasury without rating the operator", async () => {
        const purchase = await newPurchase();
        const now = Number((await client.getBlock()).timestamp);
        const id = await storeVerdict({
          liable: 2,
          amount: 50_000n,
          payee: merchant,
          deadline: now - 1,
          purchase,
        });
        const [before, [faults]] = await Promise.all([balance(merchant), feedback()]);
        expect(await settleDispute(paying, id)).toMatchObject({
          status: "settled",
          outcome: "paid",
        });
        expect((await balance(merchant)) - before).toBe(50_000n);
        expect((await feedback())[0]).toBe(faults);
        expect((await txsFor(id)).map((t) => t.contract).sort()).toEqual([
          "KeelsonReserve",
          "PYUSD",
        ]);
      });

      test("never pays more than the coverage has left", async () => {
        const purchase = await newPurchase();
        const now = Number((await client.getBlock()).timestamp);
        const id = await storeVerdict({
          liable: 1,
          amount: 1_990_000n,
          payee: merchant,
          deadline: now - 1,
          purchase,
        });
        const before = await balance(treasury.address);
        expect(await settleDispute(paying, id)).toEqual({
          status: "failed",
          disputeId: id,
          failure: "Expired",
        });
        expect(await balance(treasury.address)).toBe(before);
        const [v] = await testDb.select().from(verdicts).where(eq(verdicts.disputeId, id));
        expect(v?.paidBy).toBeNull();
      });

      test("a treasury without the PYUSD waits and pays once it has it", async () => {
        const purchase = await newPurchase();
        const now = Number((await client.getBlock()).timestamp);
        const id = await storeVerdict({
          liable: 2,
          amount: 400_000n,
          payee: merchant,
          deadline: now - 1,
          purchase,
        });
        await expect(settleDispute(paying, id)).rejects.toThrow();
        const [v] = await testDb.select().from(verdicts).where(eq(verdicts.disputeId, id));
        expect(v).toMatchObject({ outcome: "failed", paidBy: "treasury" });
        expect(await resumeSettlements(paying)).toBeGreaterThanOrEqual(1);

        await fork.client.impersonateAccount({ address: PYUSD_HOLDER });
        const funded = await fork.client.writeContract({
          account: PYUSD_HOLDER,
          chain: null,
          address: PYUSD,
          abi: iPYUSDAbi,
          functionName: "transfer",
          args: [treasury.address, 1_000_000n],
        });
        await fork.client.waitForTransactionReceipt({ hash: funded });
        await fork.client.stopImpersonatingAccount({ address: PYUSD_HOLDER });
        const before = await balance(merchant);
        await resumeSettlements(paying);
        const [done] = await testDb.select().from(verdicts).where(eq(verdicts.disputeId, id));
        expect(done).toMatchObject({ outcome: "paid", paidBy: "treasury" });
        expect((await balance(merchant)) - before).toBe(400_000n);
      });
    });

    test("a degraded verdict waits out the veto window, then the sweeper executes it", async () => {
      const before = await balance(merchant);
      const id = await storeVerdict({
        liable: 1,
        amount: 100_000n,
        payee: merchant,
        degraded: true,
      });
      expect(await settleDispute(deps, id)).toEqual({
        status: "pending",
        disputeId: id,
        waiting: "veto",
      });
      const [queued] = await testDb.select().from(verdicts).where(eq(verdicts.disputeId, id));
      expect(queued?.outcome).toBe("queued");
      const readyAt = queued?.readyAt as Date;
      const onChain = await client.readContract({
        address: chain.KeelsonBondVault as Hex,
        abi: keelsonBondVaultAbi,
        functionName: "queuedSlashes",
        args: [(queued?.message as Record<string, string> | undefined)?.disputeId as Hex],
      });
      expect(onChain.readyAt * 1000).toBe(readyAt.getTime());
      await resumeSettlements(deps);
      const [still] = await testDb.select().from(verdicts).where(eq(verdicts.disputeId, id));
      expect(still?.outcome).toBe("queued");

      // 72 hours pass, on chain and for the sweeper.
      const wait = onChain.readyAt - Number((await client.getBlock()).timestamp) + 1;
      await fork.client.increaseTime({ seconds: wait });
      await fork.client.mine({ blocks: 1 });
      await testDb
        .update(verdicts)
        .set({ readyAt: new Date(Date.now() - 1_000) })
        .where(eq(verdicts.disputeId, id));
      expect(await resumeSettlements(deps)).toBeGreaterThanOrEqual(1);
      const [done] = await testDb.select().from(verdicts).where(eq(verdicts.disputeId, id));
      expect(done?.outcome).toBe("paid");
      expect((await balance(merchant)) - before).toBe(100_000n);
      const executed = (await txsFor(id)).find((t) => t.function === "executeSlash");
      console.info(`executeSlash gas ${executed?.gasUsed}`);
    });

    test.skipIf(!receiver || !process.env.PAYPAL_CLIENT_ID)(
      "on the paypal rail the treasury pays a refused verdict with a sandbox Payout under its reference",
      async () => {
        const purchase = await newPurchase();
        const now = Number((await client.getBlock()).timestamp);
        const id = await storeVerdict({
          liable: 2,
          amount: 100_000n,
          payee: KEELSON_TREASURY,
          rail: "paypal",
          deadline: now - 1,
          purchase,
        });
        await testDb
          .insert(merchantSettlement)
          .values({ merchantId: "mrc_runfast", rail: "paypal", paypalReceiver: receiver })
          .onConflictDoUpdate({
            target: merchantSettlement.merchantId,
            set: { rail: "paypal", paypalReceiver: receiver },
          });
        const live: SettleDeps = {
          ...deps,
          paypal: createPayPalDeps({
            PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID as string,
            PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET as string,
            PAYPAL_ENV: "sandbox",
            PAYPAL_MERCHANT_ID: "A4WCRYD5EYDF2",
          }),
        };
        const started = performance.now();
        let out = await settleDispute(live, id);
        expect(out).toEqual({ status: "pending", disputeId: id, waiting: "payout" });
        const [waiting] = await testDb.select().from(verdicts).where(eq(verdicts.disputeId, id));
        expect(waiting).toMatchObject({ outcome: "failed", paidBy: "treasury" });
        while (out.status === "pending" && performance.now() - started < 120_000) {
          await new Promise((r) => setTimeout(r, 3_000));
          out = await settleDispute(live, id);
        }
        expect(out).toMatchObject({ status: "settled", outcome: "paid", txHash: null });
        const [v] = await testDb.select().from(verdicts).where(eq(verdicts.disputeId, id));
        expect(v).toMatchObject({
          outcome: "paid",
          paidBy: "treasury",
          failure: "Expired",
          payoutStatus: "SUCCESS",
        });
        const [p] = await testDb.select().from(purchases).where(eq(purchases.id, purchase));
        expect(p?.state).toBe("WARRANTY_PAID");
        console.info(
          `treasury payout ${v?.payoutBatchId}: verdict to SUCCESS in ${Math.round(performance.now() - started)} ms`,
        );
        await testDb.delete(merchantSettlement);
      },
      180_000,
    );

    test.skipIf(!process.env.PAYPAL_CLIENT_ID)(
      "without the treasury's key a verdict the chain refuses refunds nobody: the merchant would pay what no one reimburses",
      async () => {
        await testDb
          .update(purchases)
          .set({ paypalCaptureId: `NOT-REFUNDED-${randomBytes(4).toString("hex")}` })
          .where(eq(purchases.id, purchaseId));
        const now = Number((await client.getBlock()).timestamp);
        const id = await storeVerdict({
          liable: 2,
          amount: 1_000n,
          payee: merchant,
          deadline: now - 1,
        });
        const live: SettleDeps = {
          ...deps,
          paypal: createPayPalDeps({
            PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID as string,
            PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET as string,
            PAYPAL_ENV: "sandbox",
            PAYPAL_MERCHANT_ID: "A4WCRYD5EYDF2",
          }),
        };
        expect(await settleDispute(live, id)).toEqual({
          status: "failed",
          disputeId: id,
          failure: "Expired",
        });
        const [v] = await testDb.select().from(verdicts).where(eq(verdicts.disputeId, id));
        expect(v?.refundId).toBeNull();
      },
    );
  },
);

describe.skipIf(!process.env.PAYPAL_CLIENT_ID)(
  "a settlement payout PayPal fails",
  { timeout: 180_000 },
  () => {
    test("is reported as failed and the purchase is not marked paid", async () => {
      const userId = ulid();
      await testDb
        .insert(user)
        .values({ id: userId, name: "Tester", email: `${userId}@example.test` });
      const agentId = BigInt(Date.now());
      await testDb.insert(operators).values({
        agentId,
        chainId: 421614,
        agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
        name: "op",
        cnfJwk: {},
      });
      const mandateId = ulid();
      await testDb.insert(mandates).values({
        id: mandateId,
        userId,
        operatorAgentId: agentId,
        currency: "USD",
        maxMinor: 2_000n,
        remainingMinor: 2_000n,
        merchantIds: ["mrc_runfast"],
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      const purchaseId = ulid();
      await testDb.insert(purchases).values({
        id: purchaseId,
        mandateId,
        merchantId: "mrc_runfast",
        currency: "USD",
        amountMinor: 100n,
        cartHash: randomBytes(32),
        state: "ATTRIBUTED",
      });
      const disputeId = `PP-R-${randomBytes(5).toString("hex").toUpperCase()}`;
      await testDb.insert(disputes).values({
        id: disputeId,
        purchaseId,
        reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
        raw: {},
        state: "ATTRIBUTED",
      });
      // The warranty already reached the treasury on chain; the payout is all that is left.
      await testDb.insert(verdicts).values({
        id: ulid(),
        disputeId,
        liable: 2,
        ruleId: 60,
        amountMinor: 100n,
        currency: "USD",
        payee: KEELSON_TREASURY,
        rail: "paypal",
        digest: randomBytes(32),
        chainId: 421614,
        message: {},
        signatures: [],
        facts: {},
        outcome: "paid",
      });
      // A PayPal account id no account has: PayPal accepts the batch, then fails its item.
      await testDb
        .insert(merchantSettlement)
        .values({ merchantId: "mrc_runfast", rail: "paypal", paypalReceiver: "ZZZZZZZZZZZZZ" })
        .onConflictDoUpdate({
          target: merchantSettlement.merchantId,
          set: { rail: "paypal", paypalReceiver: "ZZZZZZZZZZZZZ" },
        });
      const deps: SettleDeps = {
        db: testDb,
        log: pino({ level: "silent" }),
        chain: { client: {} as PublicClient },
        paypal: createPayPalDeps({
          PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID as string,
          PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET as string,
          PAYPAL_ENV: "sandbox",
          PAYPAL_MERCHANT_ID: "A4WCRYD5EYDF2",
        }),
      };
      const started = performance.now();
      let out = await settleDispute(deps, disputeId);
      while (out.status === "pending" && performance.now() - started < 150_000) {
        await new Promise((r) => setTimeout(r, 3_000));
        out = await settleDispute(deps, disputeId);
      }
      expect(out).toEqual({ status: "failed", disputeId, failure: "payout FAILED" });
      expect(await settleDispute(deps, disputeId)).toEqual(out);
      const [p] = await testDb.select().from(purchases).where(eq(purchases.id, purchaseId));
      expect(p?.state).toBe("ATTRIBUTED");
      const [v] = await testDb.select().from(verdicts).where(eq(verdicts.disputeId, disputeId));
      expect(v?.payoutStatus).toBe("FAILED");
      await testDb.delete(merchantSettlement);
    });
  },
);
