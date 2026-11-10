import { randomBytes } from "node:crypto";
import { accessManagerAbi, deploymentsFor, registeredUserSetAbi, roles } from "@keelson/chain";
import { chainTxs, eq, userSetRoots } from "@keelson/db";
import { createRelayer, type Relayer } from "@keelson/relayer";
import { pino } from "pino";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ANVIL_KEY, type Fork, startFork } from "../../../packages/relayer/test/fork.ts";
import { publishUserSetRoots, rootKey } from "../src/zk/c3.ts";
import { testDb } from "./setup.ts";

/** Arbitrum Sepolia once `RegisteredUserSet` was deployed and wired. */
const BLOCK = 327_860_100n;
const chain = deploymentsFor(421614);
const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const log = pino({ level: "silent" });

/** A root no test has published: a random field element. */
const freshRoot = (): Hex =>
  `0x${(BigInt(`0x${randomBytes(32).toString("hex")}`) % R).toString(16).padStart(64, "0")}`;

describe.skipIf(!process.env.ARBITRUM_SEPOLIA_RPC_URL)(
  "publishUserSetRoots on a fork",
  { timeout: 60_000 },
  () => {
    let fork: Fork;
    let relayer: Relayer;
    const sender = privateKeyToAccount(ANVIL_KEY);

    const onChain = (root: Hex) =>
      fork.client.readContract({
        address: chain.RegisteredUserSet as Hex,
        abi: registeredUserSetAbi,
        functionName: "roots",
        args: [root],
      });

    beforeAll(async () => {
      fork = await startFork(8614, BLOCK);
      // The fork's sender stands in for the KMS relayer: the timelock grants it the publisher role.
      const timelock = chain.TimelockController as Hex;
      await fork.client.impersonateAccount({ address: timelock });
      await fork.client.setBalance({ address: timelock, value: 10n ** 18n });
      await fork.client.writeContract({
        account: timelock,
        chain: null,
        address: chain.AccessManager as Hex,
        abi: accessManagerAbi,
        functionName: "grantRole",
        args: [roles.PUBLISHER_ROLE, sender.address, 0],
      });
      relayer = createRelayer({
        db: testDb,
        log,
        chains: { 421614: { rpcUrl: fork.url, sequencerUrl: fork.url, account: sender } },
      });
    });

    afterAll(() => fork?.stop());

    test("publishes every recorded root not yet on chain, once", async () => {
      const [a, b] = [freshRoot(), freshRoot()];
      await testDb.insert(userSetRoots).values([
        { root: Buffer.from(a.slice(2), "hex"), size: 7, createdAt: new Date(Date.now() - 1000) },
        { root: Buffer.from(b.slice(2), "hex"), size: 8 },
      ]);
      await publishUserSetRoots({ db: testDb, relayer, log });
      const [atA, sizeA, revokedA] = await onChain(a);
      const [atB, sizeB] = await onChain(b);
      expect(atA).toBeGreaterThan(0n);
      expect([sizeA, revokedA, sizeB]).toEqual([7, 0n, 8]);
      expect(atB).toBeGreaterThanOrEqual(atA);

      const txs = await testDb
        .select()
        .from(chainTxs)
        .where(eq(chainTxs.key, rootKey(a)));
      expect(txs.map((t) => t.status)).toEqual(["confirmed"]);
      // Nothing is left to publish: a second run sends nothing.
      const before = (await testDb.select().from(chainTxs)).length;
      await publishUserSetRoots({ db: testDb, relayer, log });
      expect((await testDb.select().from(chainTxs)).length).toBe(before);
    });
  },
);
