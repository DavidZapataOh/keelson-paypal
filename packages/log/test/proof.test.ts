import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
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

describe("Ed25519 as the chain checks it", () => {
  const P = ed25519.Point;
  const n = P.Fn.ORDER;
  const name = "log.example/1";
  const text = `${name}\n8\n${Buffer.alloc(32).toString("base64")}\n`;
  const { scalar, pointBytes: key } = ed25519.utils.getExtendedPublicKey(
    new Uint8Array(32).fill(7),
  );
  const le = (b: Uint8Array) => b.reduceRight((x, v) => (x << 8n) | BigInt(v), 0n);
  const vkey = (() => {
    const raw = new Uint8Array([1, ...key]);
    const id = sha256(new Uint8Array([...new TextEncoder().encode(`${name}\n`), ...raw])).subarray(
      0,
      4,
    );
    return `${name}+${Buffer.from(id).toString("hex")}+${Buffer.from(raw).toString("base64")}`;
  })();

  /** A signature whose `R` carries the order-8 torsion point `t` (identity for an honest one). */
  function sign(t: InstanceType<typeof P>) {
    const r = 12345678901234567890n;
    const R = P.BASE.multiply(r).add(t).toBytes();
    const message = new TextEncoder().encode(text);
    const k = le(sha512(new Uint8Array([...R, ...key, ...message]))) % n;
    const s = (r + k * scalar) % n;
    const S = Uint8Array.from({ length: 32 }, (_, i) => Number((s >> BigInt(8 * i)) & 255n));
    const id = sha256(
      new Uint8Array([...new TextEncoder().encode(`${name}\n`), 1, ...key]),
    ).subarray(0, 4);
    const line = Buffer.from(new Uint8Array([...id, ...R, ...S])).toString("base64");
    return `${text}\n— ${name} ${line}\n`;
  }

  test("an honest signature verifies", () => {
    expect(verifyCheckpoint(sign(P.ZERO), [vkey]).size).toBe(8n);
  });

  test("a key with a torsion component is refused even when the chain would accept the signature", () => {
    const torsion = P.fromHex("26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05");
    const mixed = P.fromBytes(key).add(torsion).toBytes();
    const raw = new Uint8Array([1, ...mixed]);
    const id = sha256(new Uint8Array([...new TextEncoder().encode(`${name}\n`), ...raw])).subarray(
      0,
      4,
    );
    const mixedVkey = `${name}+${Buffer.from(id).toString("hex")}+${Buffer.from(raw).toString("base64")}`;
    expect(() => verifyCheckpoint(sign(P.ZERO), [mixedVkey])).toThrow(/not signed/);
  });

  test("a signature whose R has a torsion component is refused, as Ed25519Verifier refuses it", () => {
    const torsion = P.fromHex("26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05");
    const note = sign(torsion);
    // noble's cofactored check alone accepts it.
    const sig = Buffer.from(note.trimEnd().split(" ").at(-1) as string, "base64").subarray(4);
    expect(ed25519.verify(sig, new TextEncoder().encode(text), key, { zip215: false })).toBe(true);
    expect(() => verifyCheckpoint(note, [vkey])).toThrow(/not signed/);
  });
});
