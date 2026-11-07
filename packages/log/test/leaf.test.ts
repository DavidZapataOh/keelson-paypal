import { readFileSync } from "node:fs";
import { sha256 } from "@keelson/core";
import type { Countersign } from "@keelson/core/eip712";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Hex } from "viem";
import { describe, expect, test } from "vitest";
import {
  LEAF_PREFIX,
  type LeafMode,
  leafBytes,
  leafFromCountersign,
  leafHash,
  MAX_LEAF_BYTES,
  paypalRefCommit,
} from "../src/index.ts";

interface Captured {
  countersign: Record<string, string>;
  digest: Hex;
  signatures: { tdx: Hex; nitro: Hex | null };
}

const read = (path: string) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as Record<string, unknown>;
const twoOfTwo = read("../../core/test/vectors/countersign-2of2.json");
const degraded = read("../../core/test/vectors/countersign-degraded.json");
const measured = read("../../../engine/tee/measurements.json") as {
  tdx: { id: string };
  nitro: { id: string };
};

const message = (c: Record<string, string>): Countersign => ({
  requestId: c.requestId as Hex,
  mandateHash: c.mandateHash as Hex,
  mandateCommitment: c.mandateCommitment as Hex,
  cartHash: c.cartHash as Hex,
  agentId: BigInt(c.agentId as string),
  merchantId: c.merchantId as Hex,
  amount: BigInt(c.amount as string),
  currency: Number(c.currency),
  category: Number(c.category),
  evidenceRoot: c.evidenceRoot as Hex,
  evalHash: c.evalHash as Hex,
  policySetHash: c.policySetHash as Hex,
  decision: Number(c.decision),
  failedFieldsMask: Number(c.failedFieldsMask),
  issuedAt: Number(c.issuedAt),
  expiresAt: Number(c.expiresAt),
});

const salt = new Uint8Array(32).fill(0x5a);
const ref = paypalRefCommit(salt, "5O190127TN364715T", "0VF52814937998046");
const prev = `0x${"ab".repeat(32)}` as Hex;

const cases: [string, Captured, LeafMode][] = [
  ["allow", twoOfTwo.allow as Captured, "2of2"],
  ["deny", twoOfTwo.deny as Captured, "2of2"],
  ["degraded", degraded.degraded as Captured, "degraded"],
];

const build = (v: Captured, mode: LeafMode, prevAlibiByUser?: Hex) =>
  leafFromCountersign(
    message(v.countersign),
    v.digest,
    mode,
    v.signatures,
    {
      tdx: measured.tdx.id,
      nitro: mode === "2of2" ? measured.nitro.id : null,
    },
    ref,
    prevAlibiByUser,
  );

describe("alibi leaf", () => {
  test.each(cases)(
    "the %s leaf is under the size cap with and without a previous alibi",
    (name, v, mode) => {
      const plain = leafBytes(build(v, mode));
      const chained = leafBytes(build(v, mode, prev));
      console.log(`${name} leaf: ${plain.length} B, with prev_alibi_by_user: ${chained.length} B`);
      expect(plain.length).toBeLessThanOrEqual(MAX_LEAF_BYTES);
      expect(chained.length).toBeLessThanOrEqual(MAX_LEAF_BYTES);
      const text = new TextDecoder().decode(plain);
      expect(text.startsWith(LEAF_PREFIX)).toBe(true);
      expect(text).toContain(`"mode":"${mode}"`);
      const body = JSON.parse(text.slice(LEAF_PREFIX.length)) as { tee_sigs: string[] };
      expect(body.tee_sigs).toHaveLength(mode === "2of2" ? 2 : 1);
    },
  );

  test("the body is canonical: sorted keys, no whitespace, base64url binaries", () => {
    const text = new TextDecoder().decode(leafBytes(build(twoOfTwo.allow as Captured, "2of2")));
    const body = text.slice(LEAF_PREFIX.length);
    const keys = Object.keys(JSON.parse(body));
    expect(keys).toEqual([...keys].sort());
    expect(body).not.toMatch(/\s/);
    expect(body).not.toContain('"0x');
    expect(JSON.parse(body).alibi_id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(JSON.parse(body).issued_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  test("a degraded leaf carries no nitro signature and a 2-of-2 leaf needs one", () => {
    const allow = twoOfTwo.allow as Captured;
    const deg = degraded.degraded as Captured;
    const ids = { tdx: measured.tdx.id, nitro: measured.nitro.id };
    expect(() =>
      leafFromCountersign(
        message(allow.countersign),
        allow.digest,
        "degraded",
        allow.signatures,
        ids,
        ref,
      ),
    ).toThrow();
    expect(() =>
      leafFromCountersign(
        message(deg.countersign),
        deg.digest,
        "2of2",
        deg.signatures,
        { ...ids, nitro: null },
        ref,
      ),
    ).toThrow();
  });

  test("a leaf whose tuple lengths disagree with its mode is refused", () => {
    const fields = build(twoOfTwo.allow as Captured, "2of2");
    expect(() => leafBytes({ ...fields, mode: "degraded" })).toThrow();
    expect(() => leafBytes({ ...fields, teeSigs: [fields.teeSigs[0]] })).toThrow();
  });

  test("the leaf hash is the RFC 6962 leaf hash", () => {
    const leaf = leafBytes(build(twoOfTwo.deny as Captured, "2of2"));
    const input = new Uint8Array(leaf.length + 1);
    input.set(leaf, 1);
    expect(bytesToHex(leafHash(leaf))).toBe(bytesToHex(sha256(input)));
  });

  test("the PayPal reference commitment separates the two ids", () => {
    expect(paypalRefCommit(salt, "AB", "C")).not.toBe(paypalRefCommit(salt, "A", "BC"));
    expect(() => paypalRefCommit(new Uint8Array(31), "A", "B")).toThrow();
  });

  test("the vectors file is current", async () => {
    const { vectors } = await import("../scripts/vectors.ts");
    const committed = readFileSync(new URL("./vectors/leaf.json", import.meta.url), "utf8");
    expect(vectors()).toBe(committed);
  });
});
