import { keelsonBondVaultAbi, payoutAddressTypedData, withdrawalTypedData } from "@keelson/chain";
import { chainTxs, eq } from "@keelson/db";
import { createRelayer, type Relayer } from "@keelson/relayer";
import { pino } from "pino";
import { ulid } from "ulid";
import { type Hex, parseUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  AGENT_ID,
  ANVIL_KEY,
  depositArgs,
  type Fork,
  funder,
  startFork,
  VAULT,
} from "../../../packages/relayer/test/fork.ts";
import { createApp } from "../src/app.ts";
import { testDb, testKv } from "./setup.ts";
import { headerPrincipal } from "./tee-live.ts";

const rpc = process.env.ARBITRUM_SEPOLIA_RPC_URL && process.env.KEELSON_FUNDER_KEYS;
const IDENTITY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
const as = (...scopes: string[]) => ({
  "x-test-principal": JSON.stringify({ kind: "client", subject: "bonds-test", scopes }),
});

describe.skipIf(!rpc)(
  "gasless routes on an anvil fork of Arbitrum Sepolia",
  { timeout: 60_000 },
  () => {
    let fork: Fork;
    let relayer: Relayer;
    let app: ReturnType<typeof createApp>;
    /** The agent's owner on the fork: agent 351 is moved to this key, which the test holds. */
    const owner = privateKeyToAccount(generatePrivateKey());

    const post = (path: string, body: unknown, headers: Record<string, string>, key = ulid()) =>
      app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key, ...headers },
        body: JSON.stringify(body),
      });

    beforeAll(async () => {
      fork = await startFork(8611);
      const current = (await fork.client.readContract({
        address: IDENTITY,
        abi: [
          {
            type: "function",
            name: "ownerOf",
            stateMutability: "view",
            inputs: [{ type: "uint256" }],
            outputs: [{ type: "address" }],
          },
        ],
        functionName: "ownerOf",
        args: [AGENT_ID],
      })) as Hex;
      await fork.client.impersonateAccount({ address: current });
      await fork.client.setBalance({ address: current, value: 10n ** 18n });
      await fork.client.writeContract({
        account: current,
        chain: null,
        address: IDENTITY,
        abi: [
          {
            type: "function",
            name: "transferFrom",
            stateMutability: "nonpayable",
            inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }],
            outputs: [],
          },
        ],
        functionName: "transferFrom",
        args: [current, owner.address, AGENT_ID],
      });
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
      app = createApp({
        db: testDb,
        kv: testKv,
        log: pino({ level: "silent" }),
        authenticate: headerPrincipal,
        relayer,
      });
    });
    afterAll(() => fork?.stop());

    const deposit = async (amount: bigint) => {
      const { args } = await depositArgs(funder(), amount);
      const [, from, value, validAfter, validBefore, salt, signature] = args;
      return {
        chainId: 421614,
        kind: "authorization",
        from,
        amount: value.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        salt,
        signature,
      };
    };

    test("a deposit is relayed, and replays answer the same transaction", async () => {
      const body = await deposit(parseUnits("0.01", 6));
      expect((await post(`/v1/bonds/${AGENT_ID}/deposits`, body, {})).status).toBe(401);
      expect(
        (await post(`/v1/bonds/${AGENT_ID}/deposits`, body, as("countersign:write"))).status,
      ).toBe(403);
      const key = ulid();
      const res = await post(`/v1/bonds/${AGENT_ID}/deposits`, body, as("operators:write"), key);
      expect(res.status).toBe(200);
      const tx = (await res.json()) as {
        id: string;
        hash: Hex;
        status: string;
        explorerUrl: string;
      };
      expect(tx.status).toBe("confirmed");
      expect(tx.explorerUrl).toBe(`https://sepolia.arbiscan.io/tx/${tx.hash}`);
      expect((await fork.client.getTransactionReceipt({ hash: tx.hash })).status).toBe("success");

      const replay = await post(`/v1/bonds/${AGENT_ID}/deposits`, body, as("operators:write"), key);
      expect(replay.headers.get("idempotent-replayed")).toBe("true");
      expect(((await replay.json()) as { id: string }).id).toBe(tx.id);
      // Another idempotency key with the same authorization reaches the relayer's own key.
      const again = await post(`/v1/bonds/${AGENT_ID}/deposits`, body, as("operators:write"));
      expect(((await again.json()) as { id: string; hash: Hex }).hash).toBe(tx.hash);

      const read = await app.request(`/v1/transactions/${tx.id}`);
      expect(read.status).toBe(200);
      expect(read.headers.get("cache-control")).toBe("no-store");
      await testDb
        .update(chainTxs)
        .set({ confirmedAt: new Date(Date.now() - 600_000) })
        .where(eq(chainTxs.id, tx.id));
      const settled = await app.request(`/v1/transactions/${tx.id}`);
      expect(settled.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(((await settled.json()) as { hash: Hex }).hash).toBe(tx.hash);
      expect((await app.request(`/v1/transactions/${ulid()}`)).status).toBe(404);
    });

    test("a bad EIP-3009 signature is a 422 naming the error, and sends nothing", async () => {
      const body = { ...(await deposit(1n)), signature: `0x${"11".repeat(65)}` };
      const res = await post(`/v1/bonds/${AGENT_ID}/deposits`, body, as("operators:write"));
      expect(res.status).toBe(422);
      const problem = (await res.json()) as { code: string; error: { name: string } };
      expect(problem.code).toBe("simulation-reverted");
      expect(problem.error.name).toBeTypeOf("string");
    });

    test("a withdrawal is queued and completed, gasless", async () => {
      const nonce = await fork.client.readContract({
        address: VAULT,
        abi: keelsonBondVaultAbi,
        functionName: "nonces",
        args: [owner.address],
      });
      const deadline = (await fork.client.getBlock()).timestamp + 600n;
      const request = { agentId: AGENT_ID, amount: 1_000n, to: owner.address, nonce, deadline };
      const ownerSignature = await owner.signTypedData(withdrawalTypedData(request, 421614, VAULT));
      const res = await post(
        `/v1/bonds/${AGENT_ID}/withdrawals`,
        {
          chainId: 421614,
          amount: "1000",
          to: owner.address,
          nonce: nonce.toString(),
          deadline: deadline.toString(),
          ownerSignature,
        },
        as("operators:write"),
      );
      expect(res.status).toBe(200);
      const id = await fork.client.readContract({
        address: VAULT,
        abi: keelsonBondVaultAbi,
        functionName: "withdrawalCount",
      });
      const early = await post(`/v1/bonds/withdrawals/421614/${id}/complete`, {}, as());
      expect(early.status).toBe(422);
      expect(((await early.json()) as { error: { name: string } }).error.name).toBe("NotReady");
      await fork.client.increaseTime({ seconds: 3_600 });
      await fork.client.mine({ blocks: 1 });
      const done = await post(`/v1/bonds/withdrawals/421614/${id}/complete`, {}, as());
      expect(done.status).toBe(200);
    });

    test("a merchant's payout address is set, gasless", async () => {
      const merchant = privateKeyToAccount(generatePrivateKey());
      const payout = privateKeyToAccount(generatePrivateKey()).address;
      const deadline = (await fork.client.getBlock()).timestamp + 600n;
      const merchantSignature = await merchant.signTypedData(
        payoutAddressTypedData(
          { merchant: merchant.address, payout, nonce: 0n, deadline },
          421614,
          VAULT,
        ),
      );
      const body = {
        chainId: 421614,
        merchant: merchant.address,
        payout,
        nonce: "0",
        deadline: deadline.toString(),
        merchantSignature,
      };
      expect((await post("/v1/merchants/payout-address", body, as("operators:write"))).status).toBe(
        403,
      );
      const res = await post("/v1/merchants/payout-address", body, as("merchants:write"));
      expect(res.status).toBe(200);
      expect(
        await fork.client.readContract({
          address: VAULT,
          abi: keelsonBondVaultAbi,
          functionName: "payoutAddress",
          args: [merchant.address],
        }),
      ).toBe(payout);
    });

    test("status lists the relayer of each chain it sends on", async () => {
      const statusApp = createApp({
        db: testDb,
        kv: testKv,
        log: pino({ level: "silent" }),
        relayer,
      });
      const body = (await (await statusApp.request("/status")).json()) as {
        dependencies: {
          relayer: { status: string; chains: { chainId: number; address: string }[] };
        };
      };
      expect(body.dependencies.relayer.status).toBe("up");
      expect(body.dependencies.relayer.chains.map((c) => c.chainId)).toEqual([421614]);
      expect(body.dependencies.relayer.chains[0]?.address).toBe(
        privateKeyToAccount(ANVIL_KEY).address,
      );
    });
  },
);

test("the gasless routes answer 503 without a relayer", async () => {
  const app = createApp({
    db: testDb,
    kv: testKv,
    log: pino({ level: "silent" }),
    authenticate: headerPrincipal,
  });
  const res = await app.request("/v1/bonds/withdrawals/421614/1/complete", {
    method: "POST",
    headers: { "idempotency-key": ulid(), ...as() },
  });
  expect(res.status).toBe(503);
  expect((await app.request(`/v1/transactions/${ulid()}`)).status).toBe(404);
});
