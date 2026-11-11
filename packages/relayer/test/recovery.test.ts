import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { chainTxs, eq } from "@keelson/db";
import { pino } from "pino";
import { type Address, type Hex, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createRelayer } from "../src/relayer.ts";
import { ANVIL_KEY, depositArgs, FORK_BLOCK, type Fork, funder, PYUSD, startFork } from "./fork.ts";
import { testDb, testDbUrl } from "./setup.ts";
import { runChild } from "./spawn.ts";

const rpc = process.env.ARBITRUM_SEPOLIA_RPC_URL;
const AMOUNT = 100n;
const salt = (): Hex => `0x${randomBytes(32).toString("hex")}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A sequencer endpoint that forwards to the fork. On a send it calls `onSend` and never answers,
 * or, in `partial` mode, answers the receipt with a zero `blockHash`, as Arbitrum's sequencer will
 * once it answers at execution.
 */
function sequencerProxy(
  target: string,
  mode: "drop" | "forward" | "partial",
  onSend: () => void,
): Promise<{ url: string; server: Server }> {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { method } = JSON.parse(body) as { method: string };
    if (mode === "partial" && method === "eth_sendRawTransactionSync") {
      onSend();
      const answer = (await (
        await fetch(target, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        })
      ).json()) as { result?: { blockHash: Hex } };
      if (answer.result) answer.result.blockHash = `0x${"0".repeat(64)}`;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
      return;
    }
    if (method === "eth_sendRawTransactionSync" || method === "eth_sendRawTransaction") {
      if (mode === "forward") {
        await fetch(target, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
      }
      onSend();
      return;
    }
    const answer = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    res.writeHead(200, { "content-type": "application/json" }).end(await answer.text());
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}`, server });
    }),
  );
}

describe.skipIf(!rpc)("recovery on an anvil fork of Arbitrum Sepolia", { timeout: 120_000 }, () => {
  let fork: Fork;
  const log = pino({ level: "silent" });
  const account = privateKeyToAccount(ANVIL_KEY);
  const relayer = () =>
    createRelayer({
      db: testDb,
      log,
      chains: { 421614: { rpcUrl: fork.url, sequencerUrl: fork.url, account } },
    });
  const executions = async (nonce: Hex) => {
    const latest = await fork.client.getBlockNumber();
    if (latest <= FORK_BLOCK) return 0;
    const logs = await fork.client.getLogs({
      address: PYUSD,
      event: parseAbiItem(
        "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
      ),
      args: { authorizer: funder().address as Address, nonce },
      fromBlock: FORK_BLOCK + 1n,
      toBlock: latest,
    });
    return logs.length;
  };

  beforeAll(async () => {
    fork = await startFork(8602);
  });
  afterAll(() => fork?.stop());

  for (const mode of ["drop", "forward"] as const) {
    test(`a process killed ${mode === "drop" ? "before" : "after"} its broadcast executes the call once`, async () => {
      const s = salt();
      const { nonce } = await depositArgs(funder(), AMOUNT, undefined, s);
      let child: ReturnType<typeof runChild> | undefined;
      const proxy = await sequencerProxy(fork.url, mode, () => child?.process.kill("SIGKILL"));
      try {
        child = runChild({
          dbUrl: testDbUrl,
          rpcUrl: fork.url,
          sequencerUrl: proxy.url,
          amount: AMOUNT,
          salts: [s],
        });
        await child.done;
      } finally {
        proxy.server.close();
      }
      const key = `KeelsonBondVault.deposit:${nonce}`;
      const [row] = await testDb.select().from(chainTxs).where(eq(chainTxs.key, key));
      expect(row?.status).toBe("pending");
      expect(row?.raw).not.toBeNull();
      expect(await executions(nonce)).toBe(mode === "drop" ? 0 : 1);

      // A new process relaying the same key waits for the first and sends nothing new.
      const r = relayer();
      const { args } = await depositArgs(funder(), AMOUNT, undefined, s);
      const again = await r.submit({
        chainId: 421614,
        contract: "KeelsonBondVault",
        functionName: "depositWithAuthorization",
        args,
        key,
      });
      expect(again.id).toBe(row?.id);
      expect(again.hash).toBe(`0x${row?.hash?.toString("hex")}`);

      // The reconciler finds the receipt, or re-broadcasts the same bytes once the row is 30 s old.
      for (let i = 0; i < 40 && (await r.get(421614, key))?.status !== "confirmed"; i++) {
        await r.reconcile();
        await sleep(1_000);
      }
      const done = await r.get(421614, key);
      expect(done?.status).toBe("confirmed");
      expect(done?.nonce).toBe(row?.nonce);
      expect(await executions(nonce)).toBe(1);
    });
  }

  test("a receipt whose block was reorganized away is corrected", async () => {
    const r = relayer();
    const snapshot = (await fork.client.request({ method: "evm_snapshot" } as never)) as Hex;
    const { nonce, args } = await depositArgs(funder(), AMOUNT);
    const key = `KeelsonBondVault.deposit:${nonce}`;
    const first = await r.submit({
      chainId: 421614,
      contract: "KeelsonBondVault",
      functionName: "depositWithAuthorization",
      args,
      key,
    });
    expect(first.status).toBe("confirmed");
    const [row] = await testDb.select().from(chainTxs).where(eq(chainTxs.key, key));
    await fork.client.request({ method: "evm_revert", params: [snapshot] } as never);
    const block = await fork.client.getBlock();
    await fork.client.setNextBlockTimestamp({ timestamp: block.timestamp + 7n });
    await fork.client.request({
      method: "eth_sendRawTransaction",
      params: [`0x${row?.raw?.toString("hex")}`],
    } as never);
    await fork.client.mine({ blocks: 1 });
    await r.reconcile();
    const fixed = await r.get(421614, key);
    expect(fixed?.status).toBe("confirmed");
    expect(fixed?.blockHash).not.toBe(first.blockHash);
    const receipt = await fork.client.getTransactionReceipt({ hash: first.hash as Hex });
    expect(fixed?.blockHash).toBe(receipt.blockHash);
  });

  test("a receipt answered with a zero blockHash is completed from the node", async () => {
    let sends = 0;
    const proxy = await sequencerProxy(fork.url, "partial", () => sends++);
    try {
      const r = createRelayer({
        db: testDb,
        log,
        chains: { 421614: { rpcUrl: fork.url, sequencerUrl: proxy.url, account } },
      });
      const { nonce, args } = await depositArgs(funder(), AMOUNT);
      const tx = await r.submit({
        chainId: 421614,
        contract: "KeelsonBondVault",
        functionName: "depositWithAuthorization",
        args,
        key: `KeelsonBondVault.deposit:${nonce}`,
      });
      expect(sends).toBe(1);
      expect(tx.status).toBe("confirmed");
      const receipt = await fork.client.getTransactionReceipt({ hash: tx.hash as Hex });
      expect(tx.blockHash).toBe(receipt.blockHash);
    } finally {
      proxy.server.close();
    }
  });
});
