import { createPublicClient, keccak256, stringToBytes } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { describe, expect, test } from "vitest";
import { recordAnchor } from "../src/alibi/anchors.ts";
import { arbitrumSepoliaTransport } from "../src/chain/rpc.ts";
import { testKv } from "./setup.ts";

const rpc = process.env.ARBITRUM_SEPOLIA_RPC_URL;
/** An anchor of the sandbox log at size 353, sent by the log's anchor-now. */
const TX = "0xd7eeccbe9f845d7ccb66d35fda39ab0abb2fdd435d78d7d5d5954acd1122ef11" as const;
const ORIGIN = keccak256(stringToBytes("log.keelson.finance/alibi/2026-1"));

describe.skipIf(!rpc)("recording an anchor from its transaction", () => {
  test("its CheckpointAnchored event is known without scanning the chain's logs", async () => {
    const client = createPublicClient({
      chain: arbitrumSepolia,
      transport: arbitrumSepoliaTransport(rpc),
    });
    await testKv.del("alibi:anchors:421614:events");
    await recordAnchor({ kv: testKv, chain: { client } }, 421614, TX);
    const known = await testKv.hGet("alibi:anchors:421614:events", `${ORIGIN}:353`);
    expect(JSON.parse(known as string)).toMatchObject({ txHash: TX });
  });
});
