import { randomBytes } from "node:crypto";
import { chainTxs, eq } from "@keelson/db";
import { type Address, type Hex, parseAbiItem, toHex } from "viem";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FORK_BLOCK, type Fork, funder, PYUSD, startFork } from "./fork.ts";
import { testDb, testDbUrl } from "./setup.ts";
import { runChild } from "./spawn.ts";

const rpc = process.env.ARBITRUM_SEPOLIA_RPC_URL;

describe.skipIf(!rpc)("two processes relaying the same keys", { timeout: 120_000 }, () => {
  let fork: Fork;
  beforeAll(async () => {
    fork = await startFork(8603);
  });
  afterAll(() => fork?.stop());

  test("20 keys from two processes execute 20 times, with no conflict", async () => {
    const salts = Array.from({ length: 20 }, (): Hex => `0x${randomBytes(32).toString("hex")}`);
    const config = {
      dbUrl: testDbUrl,
      rpcUrl: fork.url,
      sequencerUrl: fork.url,
      amount: 100n,
      salts,
    };
    const [a, b] = await Promise.all([runChild(config).done, runChild(config).done]);
    const rows = await testDb.select().from(chainTxs).where(eq(chainTxs.status, "confirmed"));
    expect(rows).toHaveLength(20);
    expect(new Set(rows.map((r) => r.nonce)).size).toBe(20);
    const byId = new Map(rows.map((r) => [r.id, r]));
    // Each key has one owner, which returns its receipt. The other process gets the same row, as it stands when the
    // owner settles or after the relayer's bounded wait for a duplicate, so it may still be pending.
    for (const [i, owner] of a.results.entries()) {
      const other = b.results[i];
      expect(owner.error).toBeUndefined();
      expect(other?.error).toBeUndefined();
      expect(other?.id).toBe(owner.id);
      const row = byId.get(owner.id as string);
      expect(row).toBeDefined();
      expect([owner.status, other?.status]).toContain("confirmed");
      for (const r of [owner, other]) {
        if (r?.status === "confirmed") expect(r.hash).toBe(toHex(row?.hash as Buffer));
        expect(["confirmed", "pending"]).toContain(r?.status);
      }
    }
    const used = await fork.client.getLogs({
      address: PYUSD,
      event: parseAbiItem(
        "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
      ),
      args: { authorizer: funder().address as Address },
      fromBlock: FORK_BLOCK + 1n,
    });
    expect(used).toHaveLength(20);
  });
});
