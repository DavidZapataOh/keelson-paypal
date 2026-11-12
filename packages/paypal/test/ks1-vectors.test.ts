import { readFileSync } from "node:fs";
import {
  alibiDigest,
  type CurrencyCode,
  DST,
  fromHex,
  hashObject,
  type Json,
  sha256,
  toHex,
} from "@keelson/core";
import { describe, expect, it } from "vitest";
import {
  encodeCustomId,
  encodeInvoiceId,
  encodeVerdictRef,
  parseCustomId,
  parseInvoiceId,
  parseVerdictRef,
} from "../src/ids.ts";

type Kind = "custom_id" | "invoice_id" | "verdict_ref";

interface Vectors {
  version: string;
  valid: { kind: Kind; value: string; parsed: Record<string, unknown>; source: string }[];
  invalid: { kind: Kind; value: string; reason: string }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("./vectors/ks1-v1.json", import.meta.url), "utf8"),
) as Vectors;

/** The parser's result with every byte string as `0x` hex, as the vectors file spells it. */
function parse(kind: Kind, value: string): Record<string, unknown> | null {
  const r =
    kind === "custom_id"
      ? parseCustomId(value)
      : kind === "invoice_id"
        ? parseInvoiceId(value)
        : parseVerdictRef(value);
  if (!r) return null;
  return Object.fromEntries(
    Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? toHex(v) : v]),
  );
}

function encode(kind: Kind, p: Record<string, unknown>): string {
  if (kind === "custom_id") {
    return encodeCustomId({
      env: p.env as "s" | "p",
      kind: p.kind as "a" | "m",
      id: p.id as string,
      digest: fromHex(p.digest as string),
    });
  }
  if (kind === "invoice_id") {
    return encodeInvoiceId(p.id as string, p.seq as number, fromHex(p.digest16 as string));
  }
  return encodeVerdictRef(p.id as string, fromHex(p.digest12 as string));
}

describe("ks1 test vectors", () => {
  it("is version 1.0.0", () => {
    expect(vectors.version).toBe("1.0.0");
  });

  it.each(vectors.valid)("parses and re-encodes $kind $value", ({ kind, value, parsed }) => {
    expect(parse(kind, value)).toEqual(parsed);
    expect(encode(kind, parsed)).toBe(value);
  });

  it.each(vectors.invalid)("rejects $kind $value ($reason)", ({ kind, value }) => {
    expect(parse(kind, value)).toBeNull();
  });
});

describe("a sandbox Alibi", () => {
  const bundle = JSON.parse(
    readFileSync(
      new URL("../../alibi/test/fixtures/01M6ZWZJHWRRHQEYNJAT7NMSV8.alibi", import.meta.url),
      "utf8",
    ),
  );
  const c = bundle.tee.countersign;

  it("carries the digest of its fields in the capture's invoice_id", () => {
    const inv = parseInvoiceId(bundle.paypal.invoice_id);
    expect(inv?.id).toBe(bundle.alibi_id);
    const digest = alibiDigest({
      mandateHash: c.mandateHash,
      cartHash: c.cartHash,
      policySetHash: c.policySetHash,
      countersignDigest: bundle.tee.digest,
      merchantId: bundle.paypal.merchant_id,
      amount: { currency: bundle.eval.context.currency as CurrencyCode, minor: BigInt(c.amount) },
      paypalOrderId: bundle.paypal.order_id,
    });
    expect(toHex(inv?.digest16 ?? new Uint8Array())).toBe(toHex(digest.subarray(0, 16)));
  });

  it("carries the mandate hash the passkey signed in the hold's custom_id", () => {
    const custom = parseCustomId(bundle.paypal.custom_id);
    expect(custom?.kind).toBe("m");
    const hSd = hashObject(DST.mandate, bundle.mandate.payload_sd as Json);
    const prefix = new TextEncoder().encode(DST.mandateChallenge);
    const input = new Uint8Array(prefix.length + 1 + 64);
    input.set(prefix, 0);
    input.set(hSd, prefix.length + 1);
    input.set(
      fromHex(BigInt(c.mandateCommitment).toString(16).padStart(64, "0")),
      prefix.length + 33,
    );
    const m = sha256(input);
    expect(toHex(m)).toBe(c.mandateHash);
    expect(toHex(custom?.digest ?? new Uint8Array())).toBe(toHex(m));
  });
});
