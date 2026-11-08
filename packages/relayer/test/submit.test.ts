import { chainTxs, eq, relayerNonces } from "@keelson/db";
import { pino } from "pino";
import {
  type AbiParameter,
  type Address,
  type Hex,
  pad,
  parseEther,
  parseGwei,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ABIS } from "../src/allowlist.ts";
import { RelayerError } from "../src/errors.ts";
import { createRelayer, type Relayer } from "../src/relayer.ts";
import { ANVIL_KEY, depositArgs, type Fork, funder, PYUSD, startFork, VAULT } from "./fork.ts";
import { seedPurchase, testDb } from "./setup.ts";

const account = privateKeyToAccount(ANVIL_KEY);
const rpc = process.env.ARBITRUM_SEPOLIA_RPC_URL;

/** Zero values for every input of `fn`, nested structs included. */
function zeroArgs(fn: string): unknown[] {
  const item = ABIS.KeelsonBondVault.find((i) => i.type === "function" && i.name === fn);
  const zero = (p: AbiParameter): unknown => {
    if (p.type === "tuple") {
      const c = (p as { components: readonly AbiParameter[] }).components;
      return Object.fromEntries(c.map((x) => [x.name, zero(x)]));
    }
    if (p.type.startsWith("uint") || p.type.startsWith("int")) return 0n;
    if (p.type === "address") return "0x0000000000000000000000000000000000000000";
    if (p.type === "bool") return false;
    if (p.type === "bytes32") return pad("0x0");
    return "0x";
  };
  return (item as { inputs: readonly AbiParameter[] }).inputs.map(zero);
}

const ulidToBytes32 = (id: string): Hex => {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let n = 0n;
  for (const c of id) n = (n << 5n) | BigInt(alphabet.indexOf(c));
  return pad(`0x${n.toString(16)}`);
};

async function refusal(p: Promise<unknown>): Promise<RelayerError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(RelayerError);
  return err as RelayerError;
}

describe.skipIf(!rpc)("submit on an anvil fork of Arbitrum Sepolia", () => {
  let fork: Fork;
  const log = pino({ level: "silent" });
  const relayer = (): Relayer =>
    createRelayer({
      db: testDb,
      log,
      chains: { 421614: { rpcUrl: fork.url, sequencerUrl: fork.url, account } },
    });
  const nextNonce = async () =>
    (await testDb.select().from(relayerNonces).where(eq(relayerNonces.chainId, 421614)))[0]?.next;

  beforeAll(async () => {
    fork = await startFork(8601);
  });
  afterAll(() => fork?.stop());

  test("views and unknown functions are not relayable", async () => {
    const r = relayer();
    for (const [contract, functionName] of [
      ["CheckpointAnchor", "latest"],
      ["KeelsonBondVault", "bonds"],
      ["KeelsonBondVault", "vetoSlash"],
      ["KeelsonBondVault", "setParams"],
      ["KeelsonBondVault", "drain"],
    ] as const) {
      const err = await refusal(
        r.submit({
          chainId: 421614,
          contract,
          functionName,
          args: [],
          key: `${contract}.${functionName}:x`,
        } as never),
      );
      expect(err.code).toBe("not-allowed");
      expect(err.status).toBe(403);
    }
    expect(await testDb.select().from(chainTxs)).toHaveLength(0);
  });

  test("a reverting call returns the contract's error and spends no nonce", async () => {
    const before = await nextNonce();
    const coverageId = pad("0xdead");
    const err = await refusal(
      relayer().submit({
        chainId: 421614,
        contract: "KeelsonBondVault",
        functionName: "releaseCoverage",
        args: [coverageId],
        key: `KeelsonBondVault.releaseCoverage:${coverageId}`,
      }),
    );
    expect(err.code).toBe("simulation-reverted");
    expect(err.status).toBe(422);
    expect(err.detail).toMatchObject({ error: { name: "NotReleasable", args: [] } });
    expect(await nextNonce()).toBe(before);
    const record = await relayer().get(421614, `KeelsonBondVault.releaseCoverage:${coverageId}`);
    expect(record).toMatchObject({ status: "rejected", errorCode: "simulation-reverted" });
    expect(record?.hash).toBeUndefined();
  });

  test("a base fee above the cap sends nothing", async () => {
    await fork.client.request({
      method: "anvil_setNextBlockBaseFeePerGas",
      params: [`0x${parseGwei("2").toString(16)}`],
    } as never);
    await fork.client.mine({ blocks: 1 });
    const { args } = await depositArgs(funder(), 1n);
    const err = await refusal(
      relayer().submit({
        chainId: 421614,
        contract: "KeelsonBondVault",
        functionName: "depositWithAuthorization",
        args,
        key: "KeelsonBondVault.deposit:cap",
      }),
    );
    expect(err.code).toBe("gas-price-cap");
    await fork.client.request({
      method: "anvil_setNextBlockBaseFeePerGas",
      params: ["0x1312d00"],
    } as never);
    await fork.client.mine({ blocks: 1 });
  });

  test("a balance below the minimum sends nothing", async () => {
    const balance = await fork.client.getBalance({ address: account.address });
    await fork.client.setBalance({ address: account.address, value: parseEther("0.001") });
    try {
      const { args } = await depositArgs(funder(), 1n);
      const err = await refusal(
        relayer().submit({
          chainId: 421614,
          contract: "KeelsonBondVault",
          functionName: "depositWithAuthorization",
          args,
          key: "KeelsonBondVault.deposit:low",
        }),
      );
      expect(err.code).toBe("relayer-low-balance");
      expect(err.status).toBe(503);
    } finally {
      await fork.client.setBalance({ address: account.address, value: balance });
    }
  });

  test("a relayed EIP-3009 deposit confirms once, however often it is submitted", async () => {
    const amount = parseUnits("0.01", 6);
    const read = (address: Address) =>
      fork.client.readContract({
        address: PYUSD,
        abi: [
          {
            type: "function",
            name: "balanceOf",
            stateMutability: "view",
            inputs: [{ type: "address" }],
            outputs: [{ type: "uint256" }],
          },
        ],
        functionName: "balanceOf",
        args: [address],
      });
    const before = await read(VAULT);
    const { nonce, args } = await depositArgs(funder(), amount);
    const req = {
      chainId: 421614,
      contract: "KeelsonBondVault",
      functionName: "depositWithAuthorization",
      args,
      key: `KeelsonBondVault.deposit:${nonce}`,
    } as const;
    const r = relayer();
    const [first, second] = await Promise.all([r.submit(req), r.submit(req)]);
    expect(first.status).toBe("confirmed");
    expect(first.gasUsed).toBeGreaterThan(50_000n);
    expect(first.effectiveGasPrice).toBeGreaterThan(0n);
    expect(first.latencyMs).toBeGreaterThan(0);
    expect(second.hash).toBe(first.hash);
    expect(second.id).toBe(first.id);
    expect((await r.submit(req)).hash).toBe(first.hash);
    expect(await read(VAULT)).toBe(before + amount);
    const { args: other } = await depositArgs(funder(), amount + 1n);
    const err = await refusal(r.submit({ ...req, args: other }));
    expect(err.code).toBe("key-conflict");
    expect(err.status).toBe(409);
    expect(await r.getById(first.id)).toMatchObject({ status: "confirmed", hash: first.hash });
  });

  test("a countersign mode that does not match the purchase or its signatures is refused", async () => {
    const r = relayer();
    const lock = async (
      purchaseMode: "2of2" | "degraded",
      declared: "2of2" | "degraded" | undefined,
      bytes: number,
    ) => {
      const id = await seedPurchase(testDb, purchaseMode);
      const args = zeroArgs("lockCoverage");
      (args[0] as { coverageId: Hex }).coverageId = ulidToBytes32(id);
      args[7] = `0x${"11".repeat(bytes)}`;
      return refusal(
        r.submit({
          chainId: 421614,
          contract: "KeelsonBondVault",
          functionName: "lockCoverage",
          args,
          key: `KeelsonBondVault.lockCoverage:${id}`,
          ...(declared ? { countersignMode: declared } : {}),
        }),
      );
    };
    for (const [purchase, declared, bytes] of [
      ["degraded", "degraded", 130],
      ["2of2", "2of2", 65],
      ["2of2", "degraded", 65],
      ["degraded", "2of2", 130],
      ["2of2", undefined, 130],
    ] as const) {
      const err = await lock(purchase, declared, bytes);
      expect(err.code).toBe("countersign-mode");
    }
    expect(
      await testDb.select().from(chainTxs).where(eq(chainTxs.function, "lockCoverage")),
    ).toHaveLength(0);
    // The right mode and length reach the simulation, where the vault refuses the empty coverage.
    const err = await lock("2of2", "2of2", 130);
    expect(err.code).toBe("simulation-reverted");
  });

  test("the relayer reports its address, balance and nonce", async () => {
    const status = await relayer().status(421614);
    expect(status).toMatchObject({
      chainId: 421614,
      status: "up",
      address: account.address,
      pending: 0,
    });
    expect(status.balanceWei).toBeGreaterThan(0n);
    expect(status.nextNonce).toBe(
      BigInt(await fork.client.getTransactionCount({ address: account.address })),
    );
  });
});
