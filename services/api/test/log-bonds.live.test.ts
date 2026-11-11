import { OpenAPIHono } from "@hono/zod-openapi";
import { addresses } from "@keelson/chain";
import { createPublicClient } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { describe, expect, test } from "vitest";
import { arbitrumSepoliaTransport } from "../src/chain/rpc.ts";
import { registerLogBonds } from "../src/routes/log-bonds.ts";

/** The equivocation drill's transaction: the conformance tree and its fork at size 8. */
const DRILL_TX = "0xb87a272f7af9c0ba5455083a29a8d17845058ba784ad3928301e5f0df52141ac";

describe.skipIf(!process.env.KEELSON_LIVE)(
  "GET /v1/log/bonds on Arbitrum Sepolia",
  { timeout: 30_000 },
  () => {
    test("reports the drill's slash with its transaction", async () => {
      const client = createPublicClient({
        chain: arbitrumSepolia,
        transport: arbitrumSepoliaTransport(process.env.ARBITRUM_SEPOLIA_RPC_URL),
      });
      const app = new OpenAPIHono();
      registerLogBonds(app, { chains: { 421614: { client, logs: client } } });

      const res = await app.request("/v1/log/bonds");
      expect(res.status).toBe(200);
      const { bonds } = (await res.json()) as {
        bonds: {
          address: string;
          origin: string;
          test: boolean;
          equivocation: Record<string, unknown> | null;
        }[];
      };
      const drill = bonds.find((b) => b.address === addresses[421614].LogBondDrill);
      expect(drill).toMatchObject({
        origin: "log.keelson.finance/conformance/2026-1",
        test: true,
        canonical: true,
        beneficiary: addresses[421614].KeelsonReserve,
        bountyBps: 1000,
      });
      expect(drill?.equivocation).toMatchObject({
        size: "8",
        amountMinor: "500000",
        bountyMinor: "50000",
        prover: "0xe2689fAe8Bd580f1296aC608250D88EAF0fd82d5",
        txHash: DRILL_TX,
        explorerUrl: `https://sepolia.arbiscan.io/tx/${DRILL_TX}`,
      });
    });
  },
);
