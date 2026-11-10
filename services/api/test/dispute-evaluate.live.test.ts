// Loads reflect-metadata before @keelson/alibi/verify pulls in @keelson/attest (see tee/attest.ts).
import "../src/tee/attest.ts";
import { disputes, eq, verdicts } from "@keelson/db";
import { pino } from "pino";
import { createPublicClient, http, type PublicClient } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { beforeAll, describe, expect, test } from "vitest";
import { arbitrumSepoliaTransport } from "../src/chain/rpc.ts";
import { type EvaluateDeps, evaluateDispute } from "../src/disputes/evaluate.ts";
import { createPayPalDeps } from "../src/paypal.ts";
import { LegClient } from "../src/tee/client.ts";
import { createTee } from "../src/tee/config.ts";
import { refreshLeg } from "../src/tee/signers.ts";
import { fixture, seed } from "./dispute-fixture.ts";
import { testDb, testKv } from "./setup.ts";

/** A buyer-opened sandbox dispute PayPal has not resolved: evaluation reads it as it is now. */
const disputeId = process.env.PAYPAL_RESPOND_DISPUTE_ID;
const live =
  process.env.KEELSON_LIVE === "1" &&
  Boolean(disputeId && fixture && process.env.TEE_A_URL && process.env.TEE_B_URL);

describe.skipIf(!live)("evaluating a dispute on the live legs", { timeout: 180_000 }, () => {
  const id = disputeId as string;
  let deps: EvaluateDeps;

  beforeAll(async () => {
    const rpc = process.env.ARBITRUM_SEPOLIA_RPC_URL as string;
    const tee = createTee(
      {
        TEE_A_URL: process.env.TEE_A_URL as string,
        TEE_B_URL: process.env.TEE_B_URL as string,
        KEELSON_TEE_TOKEN: process.env.KEELSON_TEE_TOKEN as string,
        ARBITRUM_SEPOLIA_RPC_URL: rpc,
      },
      // From outside Render, leg B is further away than the countersign budget allows.
      { a: 10_000, b: 10_000 },
    );
    await refreshLeg(testDb, "a", tee);
    await refreshLeg(testDb, "b", tee);
    const client = createPublicClient({
      chain: arbitrumSepolia,
      transport: arbitrumSepoliaTransport(rpc),
    });
    deps = {
      db: testDb,
      kv: testKv,
      log: pino({ level: "silent" }),
      paypal: createPayPalDeps({
        PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID as string,
        PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET as string,
        PAYPAL_ENV: "sandbox",
        PAYPAL_MERCHANT_ID: "A4WCRYD5EYDF2",
      }),
      tee,
      chain: {
        client: client as PublicClient,
        logs: createPublicClient({ chain: arbitrumSepolia, transport: http() }) as PublicClient,
      },
      rpcUrl: rpc,
      tlog: { url: "http://127.0.0.1:9", token: "t".repeat(32) },
    };
    await seed(id, { verdict: false });
  });

  const stored = () => testDb.select().from(verdicts).where(eq(verdicts.disputeId, id));
  const state = async () =>
    (await testDb.select().from(disputes).where(eq(disputes.id, id)))[0]?.state;

  test("with a leg down there is no verdict and the dispute stays open for the retry", async () => {
    const down: EvaluateDeps = {
      ...deps,
      tee: {
        client: {
          a: deps.tee.client.a,
          b: new LegClient("b", "http://127.0.0.1:9", "t".repeat(32), 500),
        },
      },
    };
    await expect(evaluateDispute(down, id)).rejects.toThrow("leg b: unreachable");
    expect(await stored()).toHaveLength(0);
    expect(await state()).toBe("OPEN");
  });

  test("runs started together store one verdict, and later runs answer it", async () => {
    const started = performance.now();
    const runs = await Promise.all([evaluateDispute(deps, id), evaluateDispute(deps, id)]);
    const ms = Math.round(performance.now() - started);
    expect(runs[0]).toMatchObject({ status: "attributed" });
    expect(runs[1]).toEqual(runs[0]);
    expect(await stored()).toHaveLength(1);
    expect(await state()).toBe("ATTRIBUTED");
    expect(await evaluateDispute(deps, id)).toEqual(runs[0]);
    const [v] = await stored();
    expect(v?.signatures.map((s) => s.tee).sort()).toEqual([1, 2]);
    console.info(
      `evaluateDispute on the live legs: ${ms} ms, rule R${v?.ruleId}, liable ${v?.liable}`,
    );
  });
});
