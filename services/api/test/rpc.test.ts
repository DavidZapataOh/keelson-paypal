import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { chainTxs, eq } from "@keelson/db";
import { createRelayer } from "@keelson/relayer";
import { pino } from "pino";
import { ulid } from "ulid";
import { bytesToHex, createPublicClient, http, type PublicClient } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  ARBITRUM_SEPOLIA_PUBLIC_RPC,
  arbitrumSepoliaRpcUrls,
  arbitrumSepoliaTransport,
  computeUnits,
  counted,
  rpcCalls,
  rpcTransport,
  startRpcReport,
} from "../src/chain/rpc.ts";
import { releaseCoverages } from "../src/onchain/validations.ts";
import { testDb, testKv } from "./setup.ts";

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** A JSON-RPC endpoint that answers `status` and `body`, counting the requests it gets. */
async function endpoint(status: number, body: string) {
  const hits = { count: 0 };
  const server = createServer((req, res) => {
    hits.count++;
    req.resume().on("end", () => {
      res.writeHead(status, { "content-type": "application/json" }).end(body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/v2/secret-key`, hits };
}

const blockNumber = (id = 0) => JSON.stringify({ jsonrpc: "2.0", id, result: "0x2a" });

function client(urls: string[]) {
  return createPublicClient({ chain: arbitrumSepolia, transport: rpcTransport(urls) });
}

test("a rate-limited primary falls back to the next RPC", async () => {
  const primary = await endpoint(429, '{"error":"Monthly capacity limit exceeded"}');
  const secondary = await endpoint(200, blockNumber());
  expect(await client([primary.url, secondary.url]).getBlockNumber({ cacheTime: 0 })).toBe(42n);
  expect(primary.hits.count).toBeGreaterThan(0);
  expect(secondary.hits.count).toBeGreaterThan(0);
});

test("a server error falls back too", async () => {
  const primary = await endpoint(503, "unavailable");
  const secondary = await endpoint(200, blockNumber());
  expect(await client([primary.url, secondary.url]).getBlockNumber({ cacheTime: 0 })).toBe(42n);
});

test("a healthy primary serves alone", async () => {
  const primary = await endpoint(200, blockNumber());
  const secondary = await endpoint(200, blockNumber());
  expect(await client([primary.url, secondary.url]).getBlockNumber({ cacheTime: 0 })).toBe(42n);
  expect(secondary.hits.count).toBe(0);
});

test("the public RPC follows a configured one, once", () => {
  expect(arbitrumSepoliaRpcUrls("https://rpc.example/v2/key")).toEqual([
    "https://rpc.example/v2/key",
    ARBITRUM_SEPOLIA_PUBLIC_RPC,
  ]);
  expect(arbitrumSepoliaRpcUrls(undefined)).toEqual([ARBITRUM_SEPOLIA_PUBLIC_RPC]);
  expect(arbitrumSepoliaRpcUrls(ARBITRUM_SEPOLIA_PUBLIC_RPC)).toEqual([
    ARBITRUM_SEPOLIA_PUBLIC_RPC,
  ]);
});

describe("the coverage release sweep", { timeout: 60_000 }, () => {
  const sweep = async (transport: ReturnType<typeof rpcTransport>) => {
    const client = createPublicClient({ chain: arbitrumSepolia, transport }) as PublicClient;
    return releaseCoverages({
      db: testDb,
      kv: testKv,
      log: pino({ level: "silent" }),
      relayer: createRelayer({ db: testDb, log: pino({ level: "silent" }), chains: {} }),
      chain: { client, logs: client },
    });
  };

  const key = `KeelsonBondVault.lockCoverage:${bytesToHex(randomBytes(32))}`;
  afterAll(async () => {
    await testDb.delete(chainTxs).where(eq(chainTxs.key, key));
  });

  beforeAll(async () => {
    // A lock whose coverage the vault never held: the sweep reads it and has nothing to release.
    await testDb.insert(chainTxs).values({
      id: ulid(),
      chainId: arbitrumSepolia.id,
      key,
      contract: "KeelsonBondVault",
      function: "lockCoverage",
      sender: Buffer.alloc(20),
      to: Buffer.alloc(20),
      data: Buffer.alloc(0),
      dataHash: Buffer.alloc(32),
      status: "confirmed",
      confirmedAt: new Date(),
    });
  });

  test("reads the vault through the public RPC when the configured one is rate-limited", async () => {
    const primary = await endpoint(429, '{"error":"Monthly capacity limit exceeded"}');
    expect(await sweep(arbitrumSepoliaTransport(primary.url))).toBe(0);
    expect(primary.hits.count).toBeGreaterThan(0);
  });

  test("fails without a fallback", async () => {
    const primary = await endpoint(429, '{"error":"Monthly capacity limit exceeded"}');
    await expect(sweep(rpcTransport([primary.url]))).rejects.toThrow();
  });
});

test("every Arbitrum Sepolia transport goes through the shared fallback", () => {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const dirs = [
    "services/api/src",
    "services/api/bench",
    "services/api/scripts",
    "services/api/test",
    "services/agent",
    "services/mcp",
    "packages",
  ];
  const direct = [
    /\bhttp\(\s*(?:process\.)?env\./,
    /\bhttp\([^)]*ARBITRUM_SEPOLIA_RPC_URL/,
    /alchemy\.com\/v2\/[A-Za-z0-9_-]/,
  ];
  // The helper itself, and the logger's redaction test, which needs a provider-shaped URL.
  const allowed = new Set(["services/api/src/chain/rpc.ts", "services/api/test/logging.test.ts"]);
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|mts)$/.test(entry.name)) {
        if (allowed.has(relative(root, path))) continue;
        const text = readFileSync(path, "utf8");
        // An alias of the env URL handed alone to `http` or to the Alibi chain reader.
        const aliases = [
          ...text.matchAll(/(\w+)\s*=\s*process\.env\.ARBITRUM_SEPOLIA_RPC_URL\b/g),
        ].map((m) => m[1]);
        const aliased = aliases.some((name) =>
          new RegExp(`(?<!fallback\\(\\[)\\bhttp\\(${name}\\)|421614:\\s*${name}\\s*[},]`).test(
            text,
          ),
        );
        if (aliased || direct.some((re) => re.test(text))) offenders.push(relative(root, path));
      }
    }
  };
  for (const dir of dirs) walk(join(root, dir));
  expect(offenders).toEqual([]);
});

test("every request is counted by provider host and method, without the key", async () => {
  const primary = await endpoint(200, blockNumber());
  const host = new URL(primary.url).host;
  const before = rpcCalls().find((c) => c.provider === host && c.method === "eth_blockNumber");
  const c = client([primary.url]);
  await c.getBlockNumber({ cacheTime: 0 });
  await c.getBlockNumber({ cacheTime: 0 });
  const after = rpcCalls().find((c) => c.provider === host && c.method === "eth_blockNumber");
  expect((after?.calls ?? 0) - (before?.calls ?? 0)).toBe(2);
  expect(JSON.stringify(rpcCalls())).not.toContain("secret-key");
});

test("the hourly report warns when a provider's monthly projection passes the budget", async () => {
  const primary = await endpoint(200, blockNumber());
  const lines: { level: string; obj: Record<string, unknown> }[] = [];
  const log = {
    info: (obj: Record<string, unknown>) => lines.push({ level: "info", obj }),
    warn: (obj: Record<string, unknown>) => lines.push({ level: "warn", obj }),
  } as unknown as Parameters<typeof startRpcReport>[0];
  const stop = startRpcReport(log, { budget: 1_000, intervalMs: 100 });
  try {
    // Labeled as Alchemy, sent to the local endpoint.
    const transport = counted("https://arb-sepolia.g.alchemy.com/", http(primary.url));
    const alchemy = createPublicClient({ chain: arbitrumSepolia, transport });
    await alchemy.getBlockNumber({ cacheTime: 0 });
    await client([primary.url]).getBlockNumber({ cacheTime: 0 });
    await new Promise((r) => setTimeout(r, 150));
  } finally {
    stop();
  }
  const warned = lines.filter((l) => l.level === "warn").map((l) => l.obj.provider);
  // The public and local hosts have no compute-unit budget.
  expect(warned).toEqual(["arb-sepolia.g.alchemy.com"]);
  expect(computeUnits("eth_getLogs", 2)).toBe(120);
});
