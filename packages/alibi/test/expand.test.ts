import { describe, expect, test } from "vitest";
import { toBase64url } from "../src/b64.ts";
import { encodeReceipt, leafHashOf } from "../src/codec.ts";
import type { AlibiReceipt } from "../src/schema.ts";
import { collapse, expand, pointers, UNBOUND, verifyAlibi } from "../src/verify/index.ts";
import { receipts } from "./log-receipts.ts";

const r = receipts[0] as AlibiReceipt;
const now = new Date("2026-11-09T07:00:00Z");
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

describe("expand and collapse", () => {
  test.each(receipts.map((x) => [x.alibi_id, x] as const))("%s round-trips", (_, x) => {
    const e = expand(x) as { leaf: unknown };
    expect(typeof e.leaf).toBe("object");
    expect(encodeReceipt(collapse(e) as AlibiReceipt)).toEqual(encodeReceipt(x));
  });

  test("every scalar of the leaf has a pointer", () => {
    const ps = pointers(expand(r));
    expect(ps).toContain("/leaf/cart_hash");
    expect(ps).toContain("/leaf/mode");
    expect(ps).toContain("/alibi_id");
  });

  test("an edit is reported with the checks that read it", async () => {
    const e = expand(r) as { leaf: Record<string, unknown> };
    const s = e.leaf.cart_hash as string;
    e.leaf.cart_hash = `${s.slice(0, -1)}${s.endsWith("A") ? "B" : "A"}`;
    const report = await verifyAlibi(collapse(e), { now, original: r });
    expect(report.changed).toEqual(["/leaf/cart_hash"]);
    expect(report.verdict).toBe("failed");
    const blamed = report.checks.filter((c) => c.blame?.includes("/leaf/cart_hash"));
    expect(blamed.map((c) => c.id)).toContain("log.inclusion");
  });

  test("only the capture id is unbound", () => {
    expect(UNBOUND).toEqual(["/paypal/capture_id"]);
  });
});

describe("qr.leaf", () => {
  const qr = async (leafHash: string, extra: object = {}) =>
    (await verifyAlibi(r, { now, expect: { leafHash, ...extra } })).checks.find(
      (c) => c.id === "qr.leaf",
    );

  test("the link's leaf hash, in base64url or hex, is the receipt's", async () => {
    expect((await qr(toBase64url(leafHashOf(r))))?.status).toBe("pass");
    expect((await qr(hex(leafHashOf(r))))?.status).toBe("pass");
  });

  test("another leaf hash fails and names the QR", async () => {
    const other = receipts[1] as AlibiReceipt;
    expect(await qr(other.leaf_hash)).toMatchObject({ status: "fail", reason: /QR/ });
  });
});
