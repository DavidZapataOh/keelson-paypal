import { deploymentsFor } from "@keelson/chain";
import { createPublicClient, http, type PublicClient } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { expect, test } from "vitest";
import { readAmber } from "../src/verify/index.ts";
import { fixtures } from "./fixtures.ts";

const live = process.env.KEELSON_LIVE === "1";
const deployed = deploymentsFor(arbitrumSepolia.id).AmberContradictionCourt !== undefined;
const rpc = process.env.ARBITRUM_SEPOLIA_RPC_URL;

/** On Arbitrum Sepolia: the fixture's real coverage, locked before amber attestations. */
test.runIf(live && deployed)(
  "reads a coverage's amber commitment and the court's record of it",
  async () => {
    const id = fixtures[0]?.bundle.alibi_id as string;
    const client = createPublicClient({
      chain: arbitrumSepolia,
      transport: http(rpc),
    }) as PublicClient;
    const amber = await readAmber(id, { client });
    expect(amber.commitment).toBe(`0x${"0".repeat(64)}`);
    expect(amber.conviction).toBeNull();
  },
  120_000,
);
