import { decodeSign1, encodeSign1 } from "@keelson/scitt";
import { describe, expect, test } from "vitest";
import { fromBase64, toBase64 } from "../src/b64.ts";
import { receiptOf } from "../src/codec.ts";
import type { AlibiBundleV2, AlibiReceiptV2 } from "../src/schema.ts";
import { verifyAlibi } from "../src/verify/index.ts";
import { receiptKeys, v2Bundle } from "./v2.ts";

const now = new Date("2026-11-10T00:00:00Z");

async function failing(input: AlibiBundleV2 | AlibiReceiptV2) {
  const before = new Set(
    (
      await verifyAlibi(input.type.includes("receipt") ? bareOf(v2Bundle()) : v2Bundle(), {
        now,
        receiptKeys,
      })
    ).checks
      .filter((c) => c.status === "fail")
      .map((c) => c.id),
  );
  const r = await verifyAlibi(input, { now, receiptKeys });
  return r.checks.filter((c) => c.status === "fail" && !before.has(c.id)).map((c) => c.id);
}

function bareOf(b: AlibiBundleV2): AlibiReceiptV2 {
  const { tlog_proof: _, ...bare } = receiptOf(b);
  return bare;
}

function editStatement(b: AlibiBundleV2, edit: (bytes: Uint8Array) => Uint8Array): AlibiBundleV2 {
  return { ...b, statement: toBase64(edit(fromBase64(b.statement))) };
}

describe("tampering with a v2 Alibi", () => {
  test("a statement signature byte fails the statement only", async () => {
    const t = editStatement(v2Bundle(), (bytes) => {
      const s = decodeSign1(bytes);
      const sig = s.signature.slice();
      sig[10] = (sig[10] as number) ^ 1;
      return encodeSign1({ ...s, signature: sig });
    });
    expect(await failing(t)).toEqual(["scitt.statement"]);
  });

  test("a receipt path byte fails the receipt only", async () => {
    const b = bareOf(v2Bundle());
    const s = decodeSign1(fromBase64(b.statement));
    const receipt = (s.unprotected.get(394) as Uint8Array[])[0] as Uint8Array;
    const r = decodeSign1(receipt);
    const vdp = r.unprotected.get(396) as Map<number, Uint8Array[]>;
    const proof = (vdp.get(-1) as Uint8Array[])[0] as Uint8Array;
    const bad = proof.slice();
    bad[bad.length - 1] = (bad[bad.length - 1] as number) ^ 1;
    const tampered = encodeSign1({ ...r, unprotected: new Map([[396, new Map([[-1, [bad]]])]]) });
    const t = {
      ...b,
      statement: toBase64(encodeSign1({ ...s, unprotected: new Map([[394, [tampered]]]) })),
    };
    expect(await failing(t)).toEqual(["scitt.receipt"]);
  });

  test("the nitro CMW record removed fails the CMW check", async () => {
    const b = v2Bundle();
    const { nitro: _, ...attestation } = b.attestation;
    const failed = await failing({ ...b, attestation });
    expect(failed).toContain("rats.cmw");
  });

  test("a failure's reads point into the v2 bundle", async () => {
    const t = editStatement(v2Bundle(), (bytes) => {
      const s = decodeSign1(bytes);
      const sig = s.signature.slice();
      sig[0] = (sig[0] as number) ^ 1;
      return encodeSign1({ ...s, signature: sig });
    });
    const r = await verifyAlibi(t, { now, receiptKeys });
    const c = r.checks.find((x) => x.id === "scitt.statement");
    expect(c?.reads).toEqual(["/statement"]);
  });
});
