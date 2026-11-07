import { readFileSync } from "node:fs";
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vitest";
import { verifyCheckpoint, verifyProof } from "../src/index.ts";

// Appends to a Tessera log with throwaway keys, captured by the log's Go tests.
const captured = JSON.parse(
  readFileSync(new URL("./vectors/proofs.json", import.meta.url), "utf8"),
) as Record<string, { index: string; leafHash: string; proof: string; checkpoint: string }> & {
  vkeys: [string, string];
};
const { vkeys } = captured;

describe("tlog proofs", () => {
  test.each(["allow", "deny", "degraded"])("the %s append verifies against both keys", (name) => {
    const c = captured[name] as { index: string; leafHash: string; proof: string };
    const out = verifyProof(c.proof, hexToBytes(c.leafHash), vkeys);
    expect(out.index).toBe(BigInt(c.index));
    expect(out.checkpoint.size).toBeGreaterThan(out.index);
  });

  test("another leaf hash does not verify", () => {
    const c = captured.deny as { leafHash: string; proof: string };
    const other = hexToBytes(c.leafHash);
    other[0] = (other[0] as number) ^ 1;
    expect(() => verifyProof(c.proof, other, vkeys)).toThrow();
  });

  test("a checkpoint missing either signature does not verify", () => {
    const signed = (captured.degraded as { checkpoint: string }).checkpoint;
    const lines = signed.split("\n");
    const sigs = lines.filter((l) => l.startsWith("—"));
    expect(sigs).toHaveLength(2);
    for (const drop of sigs) {
      expect(() => verifyCheckpoint(signed.replace(`${drop}\n`, ""), vkeys)).toThrow();
    }
    expect(verifyCheckpoint(signed, vkeys).origin).toBe("log.keelson.finance/alibi/2026-1");
  });

  test("a changed root or size does not verify", () => {
    const signed = (captured.degraded as { checkpoint: string }).checkpoint;
    const [origin, size, ...rest] = signed.split("\n");
    expect(() =>
      verifyCheckpoint([origin, String(Number(size) + 1), ...rest].join("\n"), vkeys),
    ).toThrow();
  });

  test("a vkey for another origin is refused", () => {
    const c = captured.allow as { leafHash: string; proof: string };
    const other = vkeys[0].replace("alibi/2026-1", "alibi-live/2026-1");
    expect(() => verifyProof(c.proof, hexToBytes(c.leafHash), [other])).toThrow();
  });
});
