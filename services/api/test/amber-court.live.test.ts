import { amberContradictionCourtAbi, deploymentsFor } from "@keelson/chain";
import { amberConvictions } from "@keelson/db";
import { pino } from "pino";
import { createPublicClient, http, type PublicClient } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { expect, test } from "vitest";
import {
  AMBER_CHAIN_ID,
  AMBER_COURT_DEPLOYED_AT,
  syncAmberConvictions,
} from "../src/chain/amber-court.ts";
import { arbitrumSepoliaTransport } from "../src/chain/rpc.ts";
import { testDb, testKv } from "./setup.ts";
import { live } from "./tee-live.ts";

const court = deploymentsFor(AMBER_CHAIN_ID).AmberContradictionCourt;

/** Against the deployed `AmberContradictionCourt`: the projection holds every conviction the chain does. */
test.runIf(live && court !== undefined)(
  "projects every conviction of the deployed court, then reads nothing until the next window",
  async () => {
    const client = createPublicClient({
      chain: arbitrumSepolia,
      transport: arbitrumSepoliaTransport(process.env.ARBITRUM_SEPOLIA_RPC_URL),
    }) as PublicClient;
    const logs = createPublicClient({ chain: arbitrumSepolia, transport: http() }) as PublicClient;
    await testKv.del(`amber:court:${AMBER_CHAIN_ID}:${court?.toLowerCase()}`);
    const deps = {
      db: testDb,
      kv: testKv,
      log: pino({ level: "silent" }),
      chain: { client, logs },
    };
    await syncAmberConvictions(deps);
    const onChain = await logs.getContractEvents({
      address: court as `0x${string}`,
      abi: amberContradictionCourtAbi,
      eventName: "AmberContradictionProven",
      fromBlock: AMBER_COURT_DEPLOYED_AT,
      toBlock: BigInt(
        (await testKv.get(`amber:court:${AMBER_CHAIN_ID}:${court?.toLowerCase()}`)) as string,
      ),
    });
    const projected = await testDb.select().from(amberConvictions);
    for (const e of onChain) {
      const row = projected.find(
        (p) => `0x${p.coverageId.toString("hex")}` === e.args.coverageId?.toLowerCase(),
      );
      expect(row?.fieldId).toBe(e.args.fieldId);
      expect(`0x${row?.webFactDigest.toString("hex")}`).toBe(e.args.webFactDigest?.toLowerCase());
    }
    // Within the window, a second read asks the chain nothing.
    let calls = 0;
    const counting = new Proxy(logs, {
      get: (target, key) => {
        if (key === "getBlockNumber" || key === "getContractEvents") calls++;
        return Reflect.get(target, key);
      },
    });
    await syncAmberConvictions({ ...deps, chain: { client, logs: counting } });
    expect(calls).toBe(0);
  },
  300_000,
);
