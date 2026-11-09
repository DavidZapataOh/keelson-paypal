import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  addresses,
  keelsonBondVaultAbi,
  keelsonReputationReporterAbi,
  keelsonValidationRegistryAbi,
} from "@keelson/chain";
import { agentRegistry, ERC8004, reputationRegistryAbi } from "@keelson/erc8004";
import { pino } from "pino";
import { createPublicClient, http, keccak256 } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { DEMO_OPERATOR } from "../src/routes/operators.ts";
import { testDb, testKv } from "./setup.ts";

const live = process.env.KEELSON_LIVE === "1";
const deployed = addresses[421614];
const vault = deployed.KeelsonBondVault;
const reporter = deployed.KeelsonReputationReporter;
const validation = deployed.KeelsonValidationRegistry;
const verifier = deployed.VerdictVerifier;
const client = createPublicClient({
  chain: arbitrumSepolia,
  transport: http(process.env.ARBITRUM_SEPOLIA_RPC_URL),
});
const logs = createPublicClient({ chain: arbitrumSepolia, transport: http() });
const app = createApp({
  db: testDb,
  kv: testKv,
  log: pino({ level: "silent" }),
  chains: { 421614: { client, logs } },
});
const agentId = DEMO_OPERATOR.agentId;

/** Live Arbitrum Sepolia: the vault, the official Reputation registry and Keelson's ERC-8004 contracts. */
describe.skipIf(!live)("ERC-8004 reads on Arbitrum Sepolia", { timeout: 60_000 }, () => {
  test.skipIf(!reporter || !validation)(
    "the demo operator's bond is what the contracts return",
    async () => {
      const started = performance.now();
      const res = await app.request(`/v1/operators/421614/${agentId}/bond`);
      const ms = performance.now() - started;
      expect(res.status).toBe(200);
      const body = await res.json();
      const reputation = {
        address: ERC8004[421614].reputation,
        abi: reputationRegistryAbi,
      } as const;
      const [b, all, slashes, validations] = await Promise.all([
        client.readContract({
          address: vault as `0x${string}`,
          abi: keelsonBondVaultAbi,
          functionName: "bonds",
          args: [agentId],
        }),
        client.readContract({
          ...reputation,
          functionName: "getSummary",
          args: [agentId, [reporter as `0x${string}`], "keelson", ""],
        }),
        client.readContract({
          ...reputation,
          functionName: "getSummary",
          args: [agentId, [reporter as `0x${string}`], "keelson", "slash"],
        }),
        client.readContract({
          address: validation as `0x${string}`,
          abi: keelsonValidationRegistryAbi,
          functionName: "getSummary",
          args: [agentId, [verifier as `0x${string}`], ""],
        }),
      ]);
      expect(body).toEqual({
        bond: {
          free: b.free.toString(),
          locked: b.locked.toString(),
          queued: b.queued.toString(),
          slashCount: Number(b.slashCount),
        },
        reputation: {
          count: Number(all[0]),
          value: all[1].toString(),
          decimals: all[2],
          slashes: Number(slashes[0]),
        },
        validation: { count: Number(validations[0]), averageResponse: validations[1] },
      });
      expect(res.headers.get("server-timing")).toMatch(/^chain;dur=[\d.]+;desc=(hit|miss)$/);
      const again = await app.request(`/v1/operators/421614/${agentId}/bond`);
      expect(again.headers.get("server-timing")).toMatch(/;desc=hit$/);
      expect(await again.json()).toEqual(body);
      console.info(`GET bond: ${ms.toFixed(0)} ms, ${res.headers.get("server-timing")}`);
    },
  );

  test.skipIf(reporter)(
    "the bond is not found before the ERC-8004 contracts are deployed",
    async () => {
      expect((await app.request(`/v1/operators/421614/${agentId}/bond`)).status).toBe(404);
    },
  );

  test.skipIf(!reporter)("a rated coverage's feedback file is the chain's feedback", async () => {
    const [rated] = await logs.getContractEvents({
      address: reporter as `0x${string}`,
      abi: keelsonReputationReporterAbi,
      eventName: "CoverageRated",
      fromBlock: 327_279_949n,
    });
    if (!rated) throw new Error("no coverage has been rated on Arbitrum Sepolia");
    const { coverageId, agentId: rater, value } = rated.args;
    const started = performance.now();
    const res = await app.request(`/v1/feedback/${coverageId}`);
    const ms = performance.now() - started;
    expect(res.status).toBe(200);
    const block = await client.getBlock({ blockNumber: rated.blockNumber });
    expect(await res.json()).toEqual({
      agentRegistry: agentRegistry(421614),
      agentId: Number(rater),
      clientAddress: `eip155:421614:${reporter}`,
      createdAt: new Date(Number(block.timestamp) * 1000).toISOString().replace(".000Z", "Z"),
      value: Number(value),
      valueDecimals: 2,
      tag1: "keelson",
      tag2: Number(value) > 0 ? "release" : "slash",
      keelson: { coverageId, txHash: rated.transactionHash },
    });
    console.info(`GET feedback: ${ms.toFixed(0)} ms`);
  });

  test("a validation recorded on-chain serves its countersign from the recording calldata", async () => {
    const coverage = JSON.parse(
      readFileSync(
        new URL("../../../contracts/test/vectors/coverage-live.json", import.meta.url),
        "utf8",
      ),
    );
    const res = await app.request(`/v1/validations/${coverage.digest}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(keccak256(body.payload)).toBe(coverage.digest);
    expect(body.countersign.requestId).toBe(coverage.countersign.requestId);
  });

  test("an agent id beyond uint64 is refused before any chain read", async () => {
    const res = await app.request(`/v1/operators/421614/${2n ** 64n}/bond`);
    expect(res.status).toBe(422);
  });

  test("an unrated coverage has no feedback file", async () => {
    const started = performance.now();
    const res = await app.request(`/v1/feedback/0x${randomBytes(32).toString("hex")}`);
    console.info(`GET feedback (not rated): ${(performance.now() - started).toFixed(0)} ms`);
    expect(res.status).toBe(404);
  });

  test("the demo operator's registration file lists agent 351", async () => {
    const started = performance.now();
    const res = await app.request(
      `/v1/operators/by-address/${DEMO_OPERATOR.owner}/registration.json`,
    );
    console.info(`GET registration.json: ${(performance.now() - started).toFixed(0)} ms`);
    expect(res.status).toBe(200);
    expect((await res.json()).registrations).toEqual([
      { agentId: 351, agentRegistry: agentRegistry(421614) },
    ]);
  });
});
