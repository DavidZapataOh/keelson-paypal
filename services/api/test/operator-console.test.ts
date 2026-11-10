import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { bondPermitTypedData, keelsonBondVaultAbi, PYUSD_ARBITRUM_SEPOLIA } from "@keelson/chain";
import { disputes, mandates, operators, purchases, user, verdicts } from "@keelson/db";
import { createRelayer } from "@keelson/relayer";
import { pino } from "pino";
import { ulid } from "ulid";
import { erc20Abi, type Hex, parseAbi } from "viem";
import { generatePrivateKey, type LocalAccount, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  AGENT_ID,
  ANVIL_KEY,
  type Fork,
  funder,
  startFork,
  VAULT,
} from "../../../packages/relayer/test/fork.ts";
import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth.ts";
import { authenticate } from "../src/middleware/auth.ts";
import { coverageRows, filterSql } from "../src/routes/operator-console.ts";
import { testAuthEnv, testDb, testKv } from "./setup.ts";

const rpc = process.env.ARBITRUM_SEPOLIA_RPC_URL && process.env.KEELSON_FUNDER_KEYS;
const IDENTITY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
const REGISTRY = `eip155:421614:${IDENTITY}`;

/** Seeds `n` covered purchases of `agentId`, one disputed with the operator at fault. */
async function seed(agentId: bigint, n: number, ownerAddress?: Hex) {
  const userId = ulid();
  await testDb.insert(user).values({ id: userId, name: "Buyer", email: `${userId}@example.test` });
  await testDb
    .insert(operators)
    .values({
      agentId,
      chainId: 421614,
      agentRegistry: REGISTRY,
      name: "Test operator",
      cnfJwk: {},
      ...(ownerAddress ? { ownerAddress: Buffer.from(ownerAddress.slice(2), "hex") } : {}),
    })
    .onConflictDoNothing();
  const mandateId = ulid();
  await testDb.insert(mandates).values({
    id: mandateId,
    userId,
    operatorAgentId: agentId,
    currency: "USD",
    maxMinor: 10_000_000_000n,
    remainingMinor: 10_000_000_000n,
    merchantIds: ["mrc_runfast", "mrc_trailhead"],
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  const day = 86_400_000;
  const start = Date.UTC(2026, 10, 1);
  const rows = Array.from({ length: n }, (_, i) => ({
    id: ulid(start + i * 60_000),
    mandateId,
    state: "SETTLED" as const,
    merchantId: i % 3 === 0 ? "mrc_trailhead" : "mrc_runfast",
    currency: "USD",
    amountMinor: BigInt(1_000 + (i % 50) * 100),
    cartHash: randomBytes(32),
    premiumBps: 100,
    createdAt: new Date(start + Math.floor(i / 10) * day + i),
  }));
  for (let i = 0; i < rows.length; i += 5_000) {
    await testDb.insert(purchases).values(rows.slice(i, i + 5_000));
  }
  const slashed = rows[0] as (typeof rows)[number];
  const disputeId = `PP-D-${randomBytes(4).toString("hex")}`;
  await testDb.insert(disputes).values({
    id: disputeId,
    purchaseId: slashed.id,
    state: "RESOLVED",
    reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
    ruleId: 3,
    liable: 1,
    raw: {},
  });
  await testDb.insert(verdicts).values({
    id: ulid(),
    disputeId,
    liable: 1,
    ruleId: 3,
    amountMinor: slashed.amountMinor,
    currency: "USD",
    payee: "mrc_trailhead",
    digest: randomBytes(32),
    chainId: 421614,
    message: {},
    signatures: [],
    facts: {},
    outcome: "paid",
    paidBy: "chain",
    txHash: randomBytes(32),
    settledAt: new Date(),
  });
  return { slashed, rows };
}

test("a filter is refused unless the column has it, and a set value unless the column knows it", () => {
  expect(() => filterSql({ state: { filterType: "set", values: ["SETTLED' or 1=1 --"] } })).toThrow(
    /no such value/,
  );
  expect(() => filterSql({ state: { filterType: "number", type: "equals", filter: 1 } })).toThrow(
    /non-number/,
  );
  expect(() =>
    filterSql({ amount: { filterType: "text", type: "contains", filter: "1" } }),
  ).toThrow(/non-text/);
});

describe("the coverage book", () => {
  const agentId = 800_000_000n + BigInt(randomBytes(3).readUIntBE(0, 3));
  let slashedId = "";
  beforeAll(async () => {
    slashedId = (await seed(agentId, 120)).slashed.id;
  });
  const block = (over: Partial<Parameters<typeof coverageRows>[2]> = {}) =>
    coverageRows(testDb, agentId, {
      startRow: 0,
      endRow: 100,
      sortModel: [],
      filterModel: {},
      ...over,
    });

  test("a text filter's value is a parameter: SQL in it matches nothing and runs nothing", async () => {
    const hostile = await block({
      filterModel: {
        merchantId: {
          filterType: "text",
          type: "contains",
          filter: "x'; drop table purchases; --",
        },
      },
    });
    expect(hostile.rowCount).toBe(0);
    expect((await block()).rowCount).toBe(120);
  });

  test("pages newest first with the filtered total", async () => {
    const first = await block();
    expect(first.rowCount).toBe(120);
    expect(first.rows).toHaveLength(100);
    expect((first.rows[0]?.createdAt ?? "") > (first.rows[99]?.createdAt ?? "")).toBe(true);
    const rest = await block({ startRow: 100, endRow: 200 });
    expect(rest.rows).toHaveLength(20);
    expect(rest.rowCount).toBe(120);
  });

  test("sorts and filters by number (dollars), set, text and date", async () => {
    const sorted = await block({ sortModel: [{ colId: "amount", sort: "desc" }] });
    expect(sorted.rows[0]?.amount).toBe(59);
    const big = await block({
      filterModel: { amount: { filterType: "number", type: "greaterThanOrEqual", filter: 50 } },
    });
    expect(big.rows.every((r) => r.amount >= 50)).toBe(true);
    expect(big.rowCount).toBe(20);
    const slashes = await block({
      filterModel: { liable: { filterType: "set", values: ["operator"] } },
    });
    expect(slashes.rowCount).toBe(1);
    expect(slashes.rows[0]).toMatchObject({
      id: slashedId,
      liable: "operator",
      rule: "R03",
      outcome: "paid",
      paidBy: "chain",
      disputeState: "RESOLVED",
    });
    expect(slashes.rows[0]?.settlementTx).toMatch(
      /^https:\/\/sepolia\.arbiscan\.io\/tx\/0x[0-9a-f]{64}$/,
    );
    const store = await block({
      filterModel: { merchantId: { filterType: "text", type: "contains", filter: "trail" } },
    });
    expect(store.rowCount).toBe(40);
    const firstDay = await block({
      filterModel: {
        createdAt: { filterType: "date", type: "equals", dateFrom: "2026-11-01 00:00:00" },
      },
    });
    expect(firstDay.rowCount).toBe(10);
    const either = await block({
      filterModel: {
        amount: {
          filterType: "number",
          operator: "OR",
          conditions: [
            { filterType: "number", type: "lessThan", filter: 11 },
            { filterType: "number", type: "greaterThan", filter: 58 },
          ],
        },
      },
    });
    expect(either.rows.every((r) => r.amount < 11 || r.amount > 58)).toBe(true);
    expect(either.rowCount).toBe(5);
  });

  test.skipIf(!process.env.KEELSON_BUDGETS)(
    "a 100-row block of 100k coverages, sorted and filtered, under 100 ms (median of 5)",
    { timeout: 300_000 },
    async () => {
      const big = 700_000_000n + BigInt(randomBytes(3).readUIntBE(0, 3));
      await seed(big, 100_000);
      await testDb.execute("analyze purchases");
      const runs: Record<string, number[]> = {};
      const cases = {
        newest: {},
        "sorted by amount": { sortModel: [{ colId: "amount", sort: "desc" as const }] },
        "filtered by store and amount, deep": {
          startRow: 20_000,
          endRow: 20_100,
          filterModel: {
            merchantId: {
              filterType: "text" as const,
              type: "contains" as const,
              filter: "runfast",
            },
            amount: { filterType: "number" as const, type: "greaterThan" as const, filter: 20 },
          },
        },
      };
      for (const [name, over] of Object.entries(cases)) {
        runs[name] = [];
        for (let i = 0; i < 6; i++) {
          const t = performance.now();
          await coverageRows(testDb, big, {
            startRow: 0,
            endRow: 100,
            sortModel: [],
            filterModel: {},
            ...over,
          });
          if (i > 0) runs[name]?.push(performance.now() - t);
        }
      }
      const medians = Object.fromEntries(
        Object.entries(runs).map(([k, v]) => [k, v.sort((a, b) => a - b)[2] as number]),
      );
      console.log("SSRM block medians (ms)", medians);
      for (const m of Object.values(medians)) expect(m).toBeLessThan(100);
    },
  );
});

describe.skipIf(!rpc)(
  "the operator console on an anvil fork of Arbitrum Sepolia",
  { timeout: 90_000 },
  () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const stranger = privateKeyToAccount(generatePrivateKey());
    const secret = randomBytes(32).toString("base64url");
    let fork: Fork;
    let app!: OpenAPIHono;
    let baseURL = "";
    let close: () => Promise<void>;
    let ownerCookie = "";

    async function signIn(account: LocalAccount): Promise<string> {
      const nonceRes = await fetch(`${baseURL}/api/auth/siwe/nonce`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseURL },
        body: "{}",
      });
      const { nonce } = (await nonceRes.json()) as { nonce: string };
      const message = createSiweMessage({
        domain: new URL(baseURL).host,
        address: account.address,
        statement: "Sign in to the Keelson operator console.",
        uri: baseURL,
        version: "1",
        chainId: 421614,
        nonce,
        expirationTime: new Date(Date.now() + 600_000),
      });
      const res = await fetch(`${baseURL}/api/auth/siwe/verify`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseURL },
        body: JSON.stringify({ message, signature: await account.signMessage({ message }) }),
      });
      if (res.status !== 200) return "";
      return res.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
    }

    const call = (path: string, init: RequestInit & { cookie?: string } = {}) =>
      fetch(`${baseURL}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          origin: baseURL,
          ...(init.cookie ? { cookie: init.cookie } : {}),
          ...(init.headers as Record<string, string> | undefined),
        },
      });

    beforeAll(async () => {
      fork = await startFork(8613);
      const ownerOfAbi = parseAbi([
        "function ownerOf(uint256) view returns (address)",
        "function transferFrom(address,address,uint256)",
      ]);
      const current = await fork.client.readContract({
        address: IDENTITY,
        abi: ownerOfAbi,
        functionName: "ownerOf",
        args: [AGENT_ID],
      });
      await fork.client.impersonateAccount({ address: current });
      await fork.client.setBalance({ address: current, value: 10n ** 18n });
      await fork.client.writeContract({
        account: current,
        chain: null,
        address: IDENTITY,
        abi: ownerOfAbi,
        functionName: "transferFrom",
        args: [current, owner.address, AGENT_ID],
      });
      // The owner holds PYUSD to deposit: one funder's, moved on the fork.
      const from = funder().address;
      await fork.client.impersonateAccount({ address: from });
      await fork.client.setBalance({ address: from, value: 10n ** 18n });
      await fork.client.writeContract({
        account: from,
        chain: null,
        address: PYUSD_ARBITRUM_SEPOLIA,
        abi: erc20Abi,
        functionName: "transfer",
        args: [owner.address, 10_000n],
      });

      await seed(AGENT_ID, 30, owner.address);
      const relayer = createRelayer({
        db: testDb,
        log: pino({ level: "silent" }),
        chains: {
          421614: {
            rpcUrl: fork.url,
            sequencerUrl: fork.url,
            account: privateKeyToAccount(ANVIL_KEY),
          },
        },
      });
      const server = serve({ fetch: (req) => app.fetch(req), port: 0, hostname: "127.0.0.1" });
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
      baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      close = () => new Promise((resolve) => server.close(() => resolve()));
      const auth = createAuth(testDb, testAuthEnv(baseURL, secret), {});
      app = createApp({
        db: testDb,
        kv: testKv,
        log: pino({ level: "silent" }),
        auth,
        authenticate: authenticate(auth, baseURL),
        chains: { 421614: { client: fork.client as never, logs: fork.client as never } },
        relayer,
      });
      ownerCookie = await signIn(owner);
    });
    afterAll(async () => {
      await close?.();
      fork?.stop();
    });

    test("only a linked operator's owner wallet opens a session", async () => {
      expect(ownerCookie).not.toBe("");
      expect(await signIn(stranger)).toBe("");
      const me = await call("/v1/operators/me", { cookie: ownerCookie });
      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject({
        wallets: [owner.address],
        operators: [{ agentId: AGENT_ID.toString(), chainId: 421614, name: "Test operator" }],
      });
      expect((await call("/v1/operators/me")).status).toBe(401);
    });

    test("the coverage book answers its owner only", async () => {
      const body = JSON.stringify({ startRow: 0, endRow: 100, sortModel: [], filterModel: {} });
      const path = `/v1/operators/${AGENT_ID}/coverages/rows`;
      expect((await call(path, { method: "POST", body })).status).toBe(401);
      const other = await call(`/v1/operators/${AGENT_ID + 1n}/coverages/rows`, {
        method: "POST",
        body,
        cookie: ownerCookie,
      });
      expect(other.status).toBe(403);
      const res = await call(path, { method: "POST", body, cookie: ownerCookie });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { rowCount: number }).rowCount).toBeGreaterThanOrEqual(30);
      const bad = await call(path, {
        method: "POST",
        body: JSON.stringify({
          startRow: 0,
          endRow: 100,
          filterModel: { state: { filterType: "number", type: "equals", filter: 1 } },
        }),
        cookie: ownerCookie,
      });
      expect(bad.status).toBe(422);
      const unknown = await call(path, {
        method: "POST",
        body: JSON.stringify({
          startRow: 0,
          endRow: 100,
          sortModel: [{ colId: "p.id; drop", sort: "asc" }],
        }),
        cookie: ownerCookie,
      });
      expect(unknown.status).toBe(422);
      const daily = await call(`/v1/operators/${AGENT_ID}/coverages/daily`, {
        cookie: ownerCookie,
      });
      const { days } = (await daily.json()) as {
        days: { day: string; coverages: number; incidents: number }[];
      };
      expect(days[0]).toMatchObject({ day: "2026-11-01", coverages: 10, incidents: 1 });
    });

    test("the session deposits its own permit, gasless, and nothing else", async () => {
      const nonce = await fork.client.readContract({
        address: PYUSD_ARBITRUM_SEPOLIA,
        abi: parseAbi(["function nonces(address) view returns (uint256)"]),
        functionName: "nonces",
        args: [owner.address],
      });
      const deadline = (await fork.client.getBlock()).timestamp + 900n;
      const value = 10_000n;
      const signature = await owner.signTypedData(
        bondPermitTypedData({ owner: owner.address, value, nonce, deadline }),
      );
      const before = await fork.client.readContract({
        address: VAULT,
        abi: keelsonBondVaultAbi,
        functionName: "bonds",
        args: [AGENT_ID],
      });
      const body = {
        chainId: 421614,
        kind: "permit",
        owner: owner.address,
        amount: value.toString(),
        deadline: deadline.toString(),
        signature,
      };
      const path = `/v1/bonds/${AGENT_ID}/deposits`;
      const strangerCookie = await signIn(stranger);
      expect(strangerCookie).toBe("");
      const foreign = await call(path, {
        method: "POST",
        body: JSON.stringify({ ...body, owner: stranger.address }),
        cookie: ownerCookie,
        headers: { "idempotency-key": ulid() },
      });
      expect(foreign.status).toBe(403);
      const res = await call(path, {
        method: "POST",
        body: JSON.stringify(body),
        cookie: ownerCookie,
        headers: { "idempotency-key": ulid() },
      });
      expect([200, 202]).toContain(res.status);
      const tx = (await res.json()) as { hash: Hex };
      expect((await fork.client.waitForTransactionReceipt({ hash: tx.hash })).status).toBe(
        "success",
      );
      const after = await fork.client.readContract({
        address: VAULT,
        abi: keelsonBondVaultAbi,
        functionName: "bonds",
        args: [AGENT_ID],
      });
      expect(after.free - before.free).toBe(value);
    });

    test("grid queries need the operator's session and a model", async () => {
      const body = JSON.stringify({
        prompt: "only slashes",
        gridState: {},
        schema: { type: "object" },
      });
      const path = `/v1/operators/${AGENT_ID}/grid-query`;
      expect((await call(path, { method: "POST", body })).status).toBe(401);
      expect((await call(path, { method: "POST", body, cookie: ownerCookie })).status).toBe(503);
    });
  },
);
