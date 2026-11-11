import { describe, expect, test } from "vitest";
import { purchaseFacts } from "../src/facts.ts";
import { refOf } from "../src/statement.ts";
import { ALLOW_CARD, ALLOW_PAYPAL, alibi, DENY_PAYPAL } from "./fixtures.ts";
import { v2Of, v2Ref } from "./v2.ts";

describe("purchaseFacts", () => {
  test("a PayPal purchase: amounts, payee and capture come from the countersign and PayPal", () => {
    const b = alibi(ALLOW_PAYPAL);
    const f = purchaseFacts(b);
    expect(f).toMatchObject({
      alibiId: ALLOW_PAYPAL,
      decision: "allow",
      currency: "USD",
      totalMinor: 100,
      rail: "paypal",
      payee: "A4WCRYD5EYDF2",
      confirmationId: "5VK089183A260134T",
      authorizationId: "7WR76477523639544",
      orderId: "8MY937060S1606416",
      env: "sandbox",
      issuedAt: 1794219430,
    });
    expect(f.requestId).toBe(b.tee.countersign.requestId);
    expect(f.mandateHash).toBe(b.tee.countersign.mandateHash);
    expect(f.cartHash).toBe(b.tee.countersign.cartHash);
    expect(f.l2).toBe(b.mandate.sd_jwt);
    expect(f.userAuth).toEqual(b.mandate.user_auth);
    expect(f.merchant.id).toBe("mrc_runfast");
  });

  test("no cart disclosed: no lines and no breakdown, never derived from the total", () => {
    const f = purchaseFacts(alibi(ALLOW_PAYPAL));
    expect(f.lines).toBeUndefined();
    expect(f.breakdown).toBeUndefined();
  });

  test("a card purchase carries the card, its approved authorization and the disclosed cart lines", () => {
    const b = alibi(ALLOW_CARD);
    const f = purchaseFacts(b);
    expect(f).toMatchObject({
      rail: "card",
      card: { issuer: "lithic", lastFour: "8479" },
      confirmationId: "5833c23b-eca7-43ae-95c8-9917d8c9ffff",
      authorizationId: "5833c23b-eca7-43ae-95c8-9917d8c9ffff",
      payee: "HSC000000000117",
      merchant: { id: "HSC000000000117", name: "HARBOR STREET COFFEE" },
      totalMinor: 1450,
    });
    expect(f.lines).toEqual([
      { sku: "hsc-house-blend-12oz", title: "hsc-house-blend-12oz", quantity: 1, unitMinor: 1450 },
    ]);
    expect(f.orderId).toBeUndefined();
  });

  test("a refused cart is a deny with its failed fields and no confirmation", () => {
    const f = purchaseFacts(alibi(DENY_PAYPAL));
    expect(f.decision).toBe("deny");
    expect(f.failedFieldsMask).toBe("2147483648");
    expect(f.confirmationId).toBeUndefined();
    expect(f.lines).toEqual([
      { sku: "00-PS-0004070", title: expect.any(String), quantity: 2, unitMinor: 295 },
    ]);
  });

  test("personal data only from the full copy", () => {
    expect(purchaseFacts(alibi(ALLOW_PAYPAL)).personal?.appLoginId).toBeTruthy();
    expect(purchaseFacts(alibi(ALLOW_CARD)).personal).toBeUndefined();
    expect(purchaseFacts(alibi(DENY_PAYPAL)).personal).toBeUndefined();
  });
});

describe("purchaseFacts of a v2 Alibi", () => {
  test("reads the countersign from the SCITT statement and everything else from the bundle", () => {
    expect(purchaseFacts(v2Of(ALLOW_PAYPAL))).toEqual({
      ...purchaseFacts(alibi(ALLOW_PAYPAL)),
      version: 2,
    });
    expect(purchaseFacts(alibi(ALLOW_PAYPAL)).version).toBe(1);
  });

  test("a statement whose claims were changed is refused", () => {
    const b = v2Of(ALLOW_PAYPAL);
    const bytes = Buffer.from(b.statement, "base64");
    bytes[60] = (bytes[60] as number) ^ 1;
    expect(() => purchaseFacts({ ...b, statement: bytes.toString("base64") })).toThrow();
  });

  test("refOf names the bundle's Transparent Statement", () => {
    expect(refOf(v2Of(ALLOW_PAYPAL))).toEqual(v2Ref("allow-2of2"));
  });
});
