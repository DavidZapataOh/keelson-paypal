import { bridgeBundle, decodeAlibi } from "@keelson/alibi";
import { verifyAlibi } from "@keelson/alibi/verify";
import { LOG_ORIGINS, LogClient, leafHash, parseStatementLeaf } from "@keelson/log";
import { bytesToHex } from "viem";
import { describe, expect, test } from "vitest";
import { fixtures } from "../../../packages/alibi/test/fixtures.ts";
import type { CountersignJson } from "../src/tee/client.ts";
import { createTee } from "../src/tee/config.ts";
import { liveEnv } from "./tee-live.ts";

const live = process.env.KEELSON_LIVE === "1" && !!process.env.LOG_WRITE_TOKEN;
const API = process.env.API_ORIGIN ?? "https://api.keelson.finance";

/**
 * The deployed leg A bridges real sandbox v1 Alibis: each v1 leaf, proven afresh under the log's
 * current key, comes back as a bridge statement over exactly its countersigned facts.
 */
describe.skipIf(!live)(
  "bridging sandbox Alibis with the deployed leg A",
  { timeout: 60_000 },
  () => {
    const tee = createTee(liveEnv());
    const origin = LOG_ORIGINS[421614] as string;
    const client = new LogClient(
      process.env.LOG_URL ?? "https://log.keelson.finance",
      process.env.LOG_WRITE_TOKEN as string,
      origin,
    );

    test.each(fixtures)("the $mode fixture", async (f) => {
      const res = await fetch(`${API}/v1/alibis/${f.id}`);
      const v1 = res.ok ? decodeAlibi(new Uint8Array(await res.arrayBuffer())) : f.bundle;
      const index = BigInt(v1.tlog_proof.split("\n")[1]?.split(" ")[1] ?? "");
      const fresh = await client.prove(index);
      const { statement } = await tee.client.a.bridge({
        leaf: v1.leaf,
        tlog_proof: fresh.proof,
        countersign: v1.tee.countersign as unknown as CountersignJson,
        chain_id: 421614,
      });
      const registered = Buffer.from(statement, "base64");
      const p = parseStatementLeaf(registered);
      expect(p.kind).toBe("bridge");
      if (p.kind !== "bridge") return;
      expect(p.claims.predecessor).toBe(bytesToHex(leafHash(Buffer.from(v1.leaf, "base64"))));
      expect(p.claims.mode).toBe(v1.tee.mode);
      const bundle = bridgeBundle(v1, registered, [], fresh.proof);
      const r = await verifyAlibi(bundle);
      expect(r.checks.find((c) => c.id === "scitt.statement")?.status).toBe("pass");
      expect(r.checks.find((c) => c.id === "leaf.view")?.status).toBe("pass");
    });
  },
);
