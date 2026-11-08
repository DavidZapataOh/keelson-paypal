import { Writable } from "node:stream";
import { pino } from "pino";
import { parseUnits } from "viem";
import { beforeAll, describe, expect, test } from "vitest";
import { kmsAccount } from "../src/kms.ts";
import { allocateNonce, nextNonce } from "../src/nonces.ts";
import { createRelayer, type Relayer } from "../src/relayer.ts";
import { kms, live } from "./env.ts";
import { depositArgs, funder } from "./fork.ts";
import { testDb } from "./setup.ts";

const rpcUrl = process.env.ARBITRUM_SEPOLIA_RPC_URL as string;

describe.skipIf(!live || !kms)(
  "a nonce gap on the Arbitrum Sepolia sequencer",
  { timeout: 60_000 },
  () => {
    const lines: { msg: string; failure?: string }[] = [];
    const log = pino(
      { level: "warn" },
      new Writable({
        write(chunk, _, done) {
          lines.push(JSON.parse(chunk.toString()));
          done();
        },
      }),
    );
    let relayer: Relayer;
    let address: `0x${string}`;

    beforeAll(async () => {
      const account = await kmsAccount({
        keyId: kms?.keyId as string,
        client: kms?.client as never,
      });
      address = account.address;
      relayer = createRelayer({ db: testDb, log, chains: { 421614: { rpcUrl, account } } });
    });

    test("an allocated nonce that is never sent heals within one sequencer expiry", async () => {
      const { createPublicClient, http } = await import("viem");
      const { arbitrumSepolia } = await import("viem/chains");
      const client = createPublicClient({ chain: arbitrumSepolia, transport: http(rpcUrl) });
      const count = async () =>
        BigInt(await client.getTransactionCount({ address, blockTag: "pending" }));
      const gap = await allocateNonce(testDb, 421614, address, count);
      expect(gap).toBe(await count());

      const { nonce, args } = await depositArgs(funder(), parseUnits("0.001", 6));
      const started = performance.now();
      const record = await relayer.submit({
        chainId: 421614,
        contract: "KeelsonBondVault",
        functionName: "depositWithAuthorization",
        args,
        key: `KeelsonBondVault.deposit:${nonce}`,
      });
      const elapsed = performance.now() - started;
      console.info(
        `gap recovered: submit ${Math.round(elapsed)} ms, nonce to receipt ${record.latencyMs} ms, tx ${record.hash}`,
      );
      expect(record.status).toBe("confirmed");
      expect(record.nonce).toBe(gap);
      expect(lines.filter((l) => l.failure === "nonce-too-high")).toHaveLength(1);
      // The sequencer parks the gapped nonce for its 1 s expiry; then one re-signed send.
      expect(record.latencyMs).toBeLessThan(4_000);
      expect(await nextNonce(testDb, 421614, address)).toBe(await count());
    });
  },
);
