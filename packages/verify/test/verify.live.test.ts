import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, test } from "vitest";
import { fetchAndVerify, verifyAlibi } from "../src/index.ts";

const API = "https://api.keelson.finance";
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

/** Runs the CLI with the Alibi on stdin. */
function run(args: string[], stdin: Uint8Array): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile("node", [cli, ...args], (err, stdout) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout }),
    );
    child.stdin?.end(stdin);
  });
}

describe.skipIf(process.env.KEELSON_LIVE !== "1")("verifying a live Alibi offline", () => {
  let id: string;
  let bytes: Uint8Array;
  beforeAll(async () => {
    const { purchases } = (await (await fetch(`${API}/v1/live-purchases`)).json()) as {
      purchases: { id: string; logIndex: string | null }[];
    };
    // The newest purchase already anchored on chain.
    for (const p of purchases.filter((p) => p.logIndex !== null)) {
      const receipt = (await (await fetch(`${API}/v1/alibis/${p.id}/receipt`)).json()) as {
        anchor?: unknown;
      };
      if (receipt.anchor) {
        id = p.id;
        break;
      }
    }
    bytes = new Uint8Array(await (await fetch(`${API}/v1/alibis/${id}`)).arrayBuffer());
  });

  test("an Alibi as issued verifies offline, its TEE signatures and log inclusion included", async () => {
    const report = await verifyAlibi(bytes);
    expect(report.verdict).toBe("verified-offline");
    expect(report.checks.filter((c) => c.status === "fail")).toEqual([]);
  });

  test("with the chain read, it is verified", async () => {
    expect((await verifyAlibi(bytes, { chain: true })).verdict).toBe("verified");
  });

  test("bytes, base64 and the parsed object give the same verdict and checks", async () => {
    const strip = (r: Awaited<ReturnType<typeof verifyAlibi>>) => ({
      verdict: r.verdict,
      checks: r.checks.map((c) => [c.id, c.status]),
    });
    const a = strip(await verifyAlibi(bytes));
    const b = strip(await verifyAlibi(Buffer.from(bytes).toString("base64")));
    const c = strip(await verifyAlibi(JSON.parse(new TextDecoder().decode(bytes))));
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  test("one changed byte fails it", async () => {
    const alibi = JSON.parse(new TextDecoder().decode(bytes));
    alibi.alibi_id = `${alibi.alibi_id.slice(0, -1)}${alibi.alibi_id.endsWith("0") ? "1" : "0"}`;
    expect((await verifyAlibi(alibi)).verdict).toBe("failed");
  });

  test("fetchAndVerify reads it from Keelson and checks it here", async () => {
    expect((await fetchAndVerify(id)).verdict).toBe("verified-offline");
  });

  test("the CLI exits 0 for the Alibi and 1 for a tampered copy", async () => {
    const ok = await run(["--json", "-"], bytes);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout).verdict).toBe("verified-offline");
    const alibi = JSON.parse(new TextDecoder().decode(bytes));
    alibi.alibi_id = `${alibi.alibi_id.slice(0, -1)}${alibi.alibi_id.endsWith("0") ? "1" : "0"}`;
    const bad = await run(["-"], new TextEncoder().encode(JSON.stringify(alibi)));
    expect(bad.code).toBe(1);
    expect(bad.stdout).toMatch(/failed/);
  });
});
