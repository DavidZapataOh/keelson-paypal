import { DST, hashObject, newId, toHex } from "@keelson/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  alibiDigest,
  encodeCustomId,
  encodeInvoiceId,
  encodeVerdictRef,
  parseCustomId,
  parseInvoiceId,
  parseVerdictRef,
  requestIdFromDigest,
} from "../src/ids.ts";

const ULID_CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = fc
  .tuple(
    fc.constantFrom(..."01234567"),
    fc.array(fc.constantFrom(...ULID_CHARS), { minLength: 25, maxLength: 25 }),
  )
  .map(([head, rest]) => head + rest.join(""));
const digest = fc.uint8Array({ minLength: 32, maxLength: 32 });

describe("custom_id", () => {
  it("is 77 characters from the allowed charset and round-trips", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("s", "p"),
        fc.constantFrom("a", "m"),
        ulid,
        digest,
        (env, kind, id, d) => {
          const s = encodeCustomId({ env, kind, id, digest: d });
          expect(s).toHaveLength(77);
          expect(s).toMatch(/^[A-Za-z0-9._-]{77}$/);
          expect(parseCustomId(s)).toEqual({ env, kind, id, digest: d });
        },
      ),
    );
  });

  it("rejects a digest that is not 32 bytes", () => {
    expect(() =>
      encodeCustomId({ env: "s", kind: "a", id: newId(), digest: new Uint8Array(31) }),
    ).toThrow(RangeError);
  });

  it("rejects malformed input", () => {
    const good = encodeCustomId({ env: "s", kind: "a", id: newId(), digest: new Uint8Array(32) });
    expect(parseCustomId(`ks1.xa.${good.slice(7)}`)).toBeNull();
    expect(parseCustomId(good.slice(1))).toBeNull();
    expect(parseCustomId(`${good}=`)).toBeNull();
    expect(parseCustomId(good.replace("ks1.", "ks2."))).toBeNull();
  });
});

describe("invoice_id", () => {
  it("is 60 characters and round-trips with a 16-byte digest", () => {
    fc.assert(
      fc.property(ulid, fc.integer({ min: 0, max: 99 }), digest, (id, seq, d) => {
        const s = encodeInvoiceId(id, seq, d);
        expect(s).toHaveLength(60);
        expect(s).toMatch(/^[A-Za-z0-9-]{60}$/);
        expect(parseInvoiceId(s)).toEqual({ id, seq, digest16: d.slice(0, 16) });
      }),
    );
  });

  it("rejects a sequence outside 0..99", () => {
    const d = new Uint8Array(32);
    expect(() => encodeInvoiceId(newId(), 100, d)).toThrow();
    expect(() => encodeInvoiceId(newId(), -1, d)).toThrow();
    expect(() => encodeInvoiceId(newId(), 1.5, d)).toThrow();
  });

  it("rejects an invalid ULID and a short digest", () => {
    expect(() => encodeInvoiceId("not-a-ulid", 0, new Uint8Array(32))).toThrow(TypeError);
    expect(() => encodeInvoiceId(newId(), 0, new Uint8Array(15))).toThrow(RangeError);
  });

  it("rejects lowercase, foreign separators and an overflowing first digit", () => {
    const id = newId();
    const s = encodeInvoiceId(id, 7, new Uint8Array(32).fill(255));
    expect(parseInvoiceId(s.toLowerCase())).toBeNull();
    expect(parseInvoiceId(s.replace(/-/g, ":"))).toBeNull();
    expect(parseInvoiceId(s.replace(/-/g, "|"))).toBeNull();
    expect(parseInvoiceId(`${s.slice(0, 34)}8${s.slice(35)}`)).toBeNull();
    expect(parseInvoiceId(`${s.slice(0, 34)}U${s.slice(35)}`)).toBeNull();
  });
});

describe("strict base64url", () => {
  const good = encodeVerdictRef(newId(), new Uint8Array(32));
  const tail = good.slice(32);
  it("rejects non-zero trailing bits, padding, foreign alphabet and wrong length", () => {
    const head = good.slice(0, 32);
    expect(parseVerdictRef(head + tail)).not.toBeNull();
    expect(parseVerdictRef(`${head}${tail.slice(0, 15)}=`)).toBeNull();
    expect(parseVerdictRef(`${head}${tail.slice(0, 15)}+`)).toBeNull();
    expect(parseVerdictRef(`${head}${tail.slice(0, 15)}/`)).toBeNull();
    expect(parseVerdictRef(`${head}${tail.slice(0, 15)}`)).toBeNull();
    const c = encodeCustomId({ env: "s", kind: "a", id: newId(), digest: new Uint8Array(32) });
    expect(parseCustomId(`${c.slice(0, 76)}B`)).toBeNull();
    expect(parseCustomId(`${c.slice(0, 76)}+`)).toBeNull();
    expect(parseCustomId(c.slice(0, 76))).toBeNull();
  });
});

describe("verdict ref", () => {
  it("is 48 characters and round-trips with a 12-byte digest", () => {
    fc.assert(
      fc.property(ulid, digest, (id, d) => {
        const s = encodeVerdictRef(id, d);
        expect(s).toHaveLength(48);
        expect(s).toMatch(/^[A-Za-z0-9._-]{48}$/);
        expect(parseVerdictRef(s)).toEqual({ id, digest12: d.slice(0, 12) });
      }),
    );
  });

  it("rejects malformed input", () => {
    const s = encodeVerdictRef(newId(), new Uint8Array(32));
    expect(parseVerdictRef(s.replace("ksv1.", "ksv2."))).toBeNull();
    expect(parseVerdictRef(s.slice(1))).toBeNull();
  });
});

describe("alibiDigest", () => {
  const fields = {
    mandateHash: `0x${"11".repeat(32)}`,
    cartHash: `0x${"22".repeat(32)}`,
    policySetHash: `0x${"33".repeat(32)}`,
    countersignDigest: `0x${"44".repeat(32)}`,
    merchantId: "MERCHANT1",
    amount: "10.00",
    currency: "USD",
  } as const;

  const snake = {
    mandate_hash: fields.mandateHash,
    cart_hash: fields.cartHash,
    policy_set_hash: fields.policySetHash,
    countersign_digest: fields.countersignDigest,
    merchant_id: "MERCHANT1",
    amount: "10.00",
    currency: "USD",
  };

  it("hashes the snake_case object under the alibi tag", () => {
    expect(alibiDigest(fields)).toEqual(hashObject(DST.alibi, snake));
    const withOrder = { ...fields, paypalOrderId: "5O190127TN364715T" };
    expect(alibiDigest(withOrder)).toEqual(
      hashObject(DST.alibi, { ...snake, paypal_order_id: "5O190127TN364715T" }),
    );
  });

  it("matches pinned vectors", () => {
    expect(toHex(alibiDigest(fields))).toBe(
      "0xa9bfed1cfc1b617e6512bcef367eb3a788df976d0405e2f304b86ac735e40506",
    );
    expect(toHex(alibiDigest({ ...fields, paypalOrderId: "5O190127TN364715T" }))).toBe(
      "0xb125aa17594491cd19c92041c89247ba704a7db126a43c95b33d1d522e8d29f9",
    );
  });

  it("rejects non-string amounts", () => {
    expect(() => alibiDigest({ ...fields, amount: 10.5 as unknown as string })).toThrow();
  });
});

describe("requestIdFromDigest", () => {
  it("is the first 36 hex characters", () => {
    fc.assert(
      fc.property(digest, (d) => {
        const r = requestIdFromDigest(d);
        expect(r).toHaveLength(36);
        expect(r).toBe(Buffer.from(d).toString("hex").slice(0, 36));
      }),
    );
  });
});
