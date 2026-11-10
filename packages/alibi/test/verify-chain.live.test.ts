import { arbitrumSepolia } from "viem/chains";
import { describe, expect, test } from "vitest";
import type { AlibiReceipt } from "../src/schema.ts";
import { createChainReader, verifyAlibi } from "../src/verify/index.ts";
import { receipts } from "./log-receipts.ts";

const live = process.env.KEELSON_LIVE === "1";
const rpc = process.env.ARBITRUM_SEPOLIA_RPC_URL;
const r = receipts[0] as AlibiReceipt;
const now = new Date("2026-11-09T07:00:00Z");
const status = (report: Awaited<ReturnType<typeof verifyAlibi>>, id: string) =>
  report.checks.find((c) => c.id === id);

describe.skipIf(!live)("chain reads on Arbitrum Sepolia", () => {
  test("one HTTP request reads the latest anchor of the receipt's log", async () => {
    let requests = 0;
    const chain = createChainReader({
      ...(rpc ? { rpc: { 421614: [rpc, ...arbitrumSepolia.rpcUrls.default.http] } } : {}),
      fetchFn: (input, init) => {
        requests++;
        return fetch(input, init);
      },
    });
    const report = await verifyAlibi(r, { now, chain });
    expect(requests).toBe(1);
    const root = status(report, "anchor.root");
    expect(root?.status).toBe("pending");
    expect(root?.reason).toContain("re-issued Alibi");
    expect(BigInt(root?.detail?.latest_size ?? "0")).toBeGreaterThan(0n);
    expect(report.rpc).toBeDefined();
    expect(status(report, "log.inclusion")?.status).toBe("pass");
  });

  test("an RPC that does not answer leaves the chain checks unreachable", async () => {
    const chain = createChainReader({ rpc: { 421614: "http://127.0.0.1:9" }, timeoutMs: 2000 });
    const report = await verifyAlibi(r, { now, chain });
    expect(status(report, "anchor.root")?.status).toBe("unreachable");
    expect(status(report, "anchor.tx")?.status).toBe("unreachable");
    expect(status(report, "log.inclusion")?.status).toBe("pass");
    expect(report.verdict).toBe("incomplete");
  });

  test("an RPC of another chain is not believed", async () => {
    const chain = createChainReader({
      rpc: { 421614: "https://ethereum-sepolia-rpc.publicnode.com" },
    });
    const report = await verifyAlibi(r, { now, chain });
    expect(status(report, "anchor.root")).toMatchObject({
      status: "unreachable",
      reason: "the RPC answered for chain 11155111",
    });
    expect(report.verdict).toBe("incomplete");
  });
});
