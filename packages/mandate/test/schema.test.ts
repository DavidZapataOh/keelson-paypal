import { describe, expect, it } from "vitest";
import { fieldColors } from "../src/colors.ts";
import { MandateError, parseMandate } from "../src/schema.ts";
import demo from "./fixtures/demo-mandate.json" with { type: "json" };

// biome-ignore lint/suspicious/noExplicitAny: tests mutate arbitrary fields to build invalid input
const clone = () => structuredClone(demo) as Record<string, any>;

function fieldOf(input: unknown): string {
  try {
    parseMandate(input);
  } catch (e) {
    expect(e).toBeInstanceOf(MandateError);
    return (e as MandateError).field;
  }
  throw new Error("expected parseMandate to throw");
}

describe("parseMandate", () => {
  it("accepts the demo mandate", () => {
    expect(parseMandate(demo).payment.currency).toBe("USD");
  });

  it("rejects a lifetime over 30 days", () => {
    const m = clone();
    m.exp = m.iat + 30 * 86400 + 1;
    expect(fieldOf(m)).toBe("exp");
  });

  it("accepts a lifetime of exactly 30 days", () => {
    const m = clone();
    m.exp = m.iat + 30 * 86400;
    expect(() => parseMandate(m)).not.toThrow();
  });

  it("rejects nbf after exp", () => {
    const m = clone();
    m.nbf = m.exp + 1;
    expect(fieldOf(m)).toBe("nbf");
  });

  it("rejects an unknown currency", () => {
    const m = clone();
    m.payment.currency = "XXX";
    expect(fieldOf(m)).toBe("payment.currency");
  });

  it("rejects negative and fractional amounts", () => {
    const m = clone();
    m.payment.constraints[0].max = -1;
    expect(fieldOf(m)).toBe("payment.constraints.0.max");
    m.payment.constraints[0].max = 10.5;
    expect(fieldOf(m)).toBe("payment.constraints.0.max");
  });

  it("rejects amounts beyond the safe integer range", () => {
    const m = clone();
    m.agent.bond.min = Number.MAX_SAFE_INTEGER + 1;
    expect(fieldOf(m)).toBe("agent.bond.min");
  });

  it("rejects empty allowed_merchants", () => {
    const m = clone();
    m.checkout.constraints[0].allowed = [];
    expect(fieldOf(m)).toBe("checkout.constraints.0.allowed");
  });

  it("rejects unknown keys and constraint types", () => {
    const m = clone();
    m.extra = 1;
    expect(fieldOf(m)).toBe("");
    const n = clone();
    n.checkout.constraints.push({ type: "checkout.unknown" });
    expect(fieldOf(n)).toBe("checkout.constraints.5.type");
  });

  it("rejects a constraint currency that differs from the payment currency", () => {
    const m = clone();
    m.payment.constraints[1].currency = "EUR";
    expect(fieldOf(m)).toBe("payment.constraints.1.currency");
  });
});

describe("fieldColors", () => {
  const mandate = parseMandate(demo);
  const none = { merchantSignedCheckout: false, zkTlsFields: new Set<string>() };

  it("colors an unproven mandate", () => {
    expect(fieldColors(mandate, none)).toEqual({
      total: "green",
      currency: "green",
      budget: "green",
      merchant: "green",
      deadline: "green",
      quantity: "green",
      agent: "green",
      bond: "green",
      items: "amber",
      category: "amber",
      variant: "amber",
      return_policy: "amber",
      subjective: "gray",
    });
  });

  it("upgrades fields with evidence", () => {
    const c = fieldColors(mandate, {
      merchantSignedCheckout: true,
      zkTlsFields: new Set(["variant"]),
    });
    expect(c.items).toBe("green");
    expect(c.variant).toBe("green");
    expect(c.category).toBe("amber");
    expect(c.return_policy).toBe("amber");
  });

  it("never makes subjective green", () => {
    const all = new Set(["category", "variant", "returns", "subjective"]);
    expect(
      fieldColors(mandate, { merchantSignedCheckout: true, zkTlsFields: all }).subjective,
    ).toBe("gray");
  });
});
