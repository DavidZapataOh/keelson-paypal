import { createServer, type Server } from "node:http";
import { createPublicClient } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { afterEach, expect, test } from "vitest";
import {
  ARBITRUM_SEPOLIA_PUBLIC_RPC,
  arbitrumSepoliaRpcUrls,
  rpcTransport,
} from "../src/chain/rpc.ts";

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
