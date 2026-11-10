import { randomBytes } from "node:crypto";
import { accessManagerAbi, addresses, keelsonBondVaultAbi, roles } from "@keelson/chain";
import { chainTxs, eq } from "@keelson/db";
import { pino } from "pino";
import { createPublicClient, type Hex, http, parseUnits } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { describe, expect, test } from "vitest";
import { CHAINS } from "../src/chains.ts";
import { kmsAccount } from "../src/kms.ts";
import { createRelayer } from "../src/relayer.ts";
import { kms, live } from "./env.ts";
import { AGENT_ID, depositArgs, funder, VAULT } from "./fork.ts";
import { testDb, testDbUrl } from "./setup.ts";
import { runChild } from "./spawn.ts";

const rpcUrl = process.env.ARBITRUM_SEPOLIA_RPC_URL as string;
const RELAYERS = [CHAINS[421614].sender, CHAINS[42161].sender] as const;
const AMOUNT = parseUnits("0.01", 6);

const pct = (sorted: number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;

describe.skipIf(!live || !kms)("live on Arbitrum Sepolia", { timeout: 600_000 }, () => {
  const client = createPublicClient({ chain: arbitrumSepolia, transport: http() });

  test("the relayer addresses hold no role in the AccessManager", async () => {
    const manager = addresses[421614].AccessManager as Hex;
    for (const address of RELAYERS) {
      for (const role of Object.values(roles)) {
        const [member] = await client.readContract({
          address: manager,
          abi: accessManagerAbi,
          functionName: "hasRole",
          args: [role, address],
        });
        expect(member).toBe(false);
      }
    }
  });

  test("100 concurrent deposits from two processes land once each, gapless", async () => {
    const account = await kmsAccount({ keyId: kms?.keyId as string, client: kms?.client as never });
    expect(account.address).toBe(CHAINS[421614].sender);
    const bond = async () =>
      (
        await client.readContract({
          address: VAULT,
          abi: keelsonBondVaultAbi,
          functionName: "bonds",
          args: [AGENT_ID],
        })
      ).free;
    const salts = Array.from({ length: 100 }, (): Hex => `0x${randomBytes(32).toString("hex")}`);
    const [freeBefore, ethBefore] = await Promise.all([
      bond(),
      client.getBalance({ address: account.address }),
    ]);
    const half = (s: Hex[]) =>
      runChild({ dbUrl: testDbUrl, rpcUrl, amount: AMOUNT, salts: s, kms: true }).done;
    const started = performance.now();
    const [a, b] = await Promise.all([half(salts.slice(0, 50)), half(salts.slice(50))]);
    const wall = performance.now() - started;
    const results = [...a.results, ...b.results];
    const outcomes = results.map((r) => String(r.status ?? r.error));
    console.info(
      Object.fromEntries(
        [...new Set(outcomes)].map((o) => [o, outcomes.filter((x) => x === o).length]),
      ),
    );
    for (const r of results) expect(r).toMatchObject({ status: "confirmed" });

    const rows = await testDb
      .select()
      .from(chainTxs)
      .where(eq(chainTxs.function, "depositWithAuthorization"));
    const mine = rows.filter((r) => results.some((x) => x.id === r.id));
    expect(mine).toHaveLength(100);
    const nonces = mine.map((r) => r.nonce as bigint).sort((x, y) => (x < y ? -1 : 1));
    expect(new Set(nonces).size).toBe(100);
    expect((nonces[99] as bigint) - (nonces[0] as bigint)).toBe(99n);

    await new Promise((r) => setTimeout(r, 3_000));
    expect((await bond()) - freeBefore).toBe(100n * AMOUNT);
    const spent = mine.reduce(
      (sum, r) => sum + (r.gasUsed as bigint) * (r.effectiveGasPrice as bigint),
      0n,
    );
    expect(ethBefore - (await client.getBalance({ address: account.address }))).toBe(spent);

    const latencies = mine.map((r) => r.latencyMs as number).sort((x, y) => x - y);
    console.info(
      `100 concurrent: wall ${Math.round(wall)} ms, latency p50 ${pct(latencies, 0.5)} p95 ${pct(latencies, 0.95)} p99 ${pct(latencies, 0.99)} ms, ${spent} wei`,
    );

    // The same 100 keys again send nothing.
    const relayer = createRelayer({
      db: testDb,
      log: pino({ level: "silent" }),
      chains: {
        421614: { rpcUrl, fallbackRpcUrls: [...arbitrumSepolia.rpcUrls.default.http], account },
      },
    });
    const countBefore = await client.getTransactionCount({ address: account.address });
    const again = await Promise.all(
      salts.map(async (salt) => {
        const { nonce, args } = await depositArgs(funder(), AMOUNT, AGENT_ID, salt);
        return relayer.submit({
          chainId: 421614,
          contract: "KeelsonBondVault",
          functionName: "depositWithAuthorization",
          args,
          key: `KeelsonBondVault.deposit:${nonce}`,
        });
      }),
    );
    expect(new Set(again.map((r) => r.id))).toEqual(new Set(results.map((r) => r.id)));
    expect(await client.getTransactionCount({ address: account.address })).toBe(countBefore);
  });
});
