import { describe, expect, it } from "vitest";
import { fieldColors, type ZkTlsField } from "../src/colors.ts";
import { MandateError, parseMandate } from "../src/schema.ts";
import demo from "./fixtures/demo-mandate.json" with { type: "json" };

// biome-ignore lint/suspicious/noExplicitAny: tests mutate arbitrary fields to build invalid input
type Loose = Record<string, any>;
const clone = () => structuredClone(demo) as Loose;

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

  it("rejects an empty keelson.category allow list", () => {
    const m = clone();
    const i = m.checkout.constraints.findIndex((c: Loose) => c.type === "keelson.category");
    m.checkout.constraints[i].allow = [];
    expect(fieldOf(m)).toBe(`checkout.constraints.${i}.allow`);
  });

  it("rejects category ids outside the category table", () => {
    const m = clone();
    const i = m.checkout.constraints.findIndex((c: Loose) => c.type === "keelson.category");
    m.checkout.constraints[i].allow = ["gpt:187", "gpt:999999"];
    expect(fieldOf(m)).toBe(`checkout.constraints.${i}.allow.1`);
    const n = clone();
    n.checkout.constraints[i].deny = ["nope"];
    expect(fieldOf(n)).toBe(`checkout.constraints.${i}.deny.0`);
  });

  it("rejects a line item with no acceptable items", () => {
    const m = clone();
    m.checkout.constraints[1].items[0].acceptable_items = [];
    expect(fieldOf(m)).toBe("checkout.constraints.1.items.0.acceptable_items");
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

describe("encodings", () => {
  it("requires a 16-byte unpadded nonce", () => {
    for (const nonce of ["AAAA", `${"A".repeat(22)}A`, `${"A".repeat(22)}==`, "A".repeat(21)]) {
      const m = clone();
      m.nonce = nonce;
      expect(fieldOf(m)).toBe("nonce");
    }
  });

  it("requires 32-byte P-256 coordinates", () => {
    for (const x of ["AAAA", "A".repeat(44), `${"A".repeat(43)}=`]) {
      const m = clone();
      m.user.cred.jwk.x = x;
      expect(fieldOf(m)).toBe("user.cred.jwk.x");
    }
  });

  it("requires the P-256 curve", () => {
    const m = clone();
    m.user.cred.jwk.crv = "P-384";
    expect(fieldOf(m)).toBe("user.cred.jwk.crv");
  });

  it("enforces iat <= nbf", () => {
    const m = clone();
    m.nbf = m.iat - 1;
    expect(fieldOf(m)).toBe("nbf");
  });

  it("validates commitment and hash formats", () => {
    const m = clone();
    m.zk.commitment = "0x1234";
    expect(fieldOf(m)).toBe("zk.commitment");
    const n = clone();
    n.policy.policy_set_hash = "abc";
    expect(fieldOf(n)).toBe("policy.policy_set_hash");
  });
});

describe("nested strictness", () => {
  it.each([
    ["user.cred.jwk", (m: Loose) => m.user.cred.jwk],
    ["payment.constraints.0", (m: Loose) => m.payment.constraints[0]],
    ["checkout.constraints.0.allowed.0", (m: Loose) => m.checkout.constraints[0].allowed[0]],
    ["consent", (m: Loose) => m.consent],
  ])("rejects an unknown key in %s", (path, pick) => {
    const m = clone();
    pick(m).extra = 1;
    expect(fieldOf(m)).toBe(path);
  });
});

describe("constraint cardinality", () => {
  it.each([
    "payment.amount_range",
    "payment.budget",
    "payment.allowed_payees",
    "payment.execution_date",
  ])("requires %s", (type) => {
    const m = clone();
    m.payment.constraints = m.payment.constraints.filter((c: { type: string }) => c.type !== type);
    expect(fieldOf(m)).toBe("payment.constraints");
  });

  it("rejects duplicate payment constraints", () => {
    const m = clone();
    m.payment.constraints.push(m.payment.constraints[0]);
    expect(fieldOf(m)).toBe("payment.constraints");
  });

  it("requires exactly one allowed_merchants and at most one of each other type", () => {
    const m = clone();
    m.checkout.constraints.shift();
    expect(fieldOf(m)).toBe("checkout.constraints");
    const n = clone();
    n.checkout.constraints.push(n.checkout.constraints[4]);
    expect(fieldOf(n)).toBe("checkout.constraints");
  });
});

describe("fieldColors", () => {
  const mandate = parseMandate(demo);
  const none = { merchantSignedCheckout: false, zkTlsFields: new Set<ZkTlsField>() };

  it("colors a minimal mandate with no unproven fields", () => {
    const m = clone();
    m.checkout.constraints = m.checkout.constraints.slice(0, 1);
    m.intent.subjective = [];
    expect(fieldColors(parseMandate(m), none)).toEqual({
      total: "green",
      currency: "green",
      budget: "green",
      merchant: "green",
      deadline: "green",
      quantity: "green",
      agent: "green",
      bond: "green",
    });
  });

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
    const proven = fieldColors(mandate, { ...none, zkTlsFields: new Set(["return_policy"]) });
    expect(proven.return_policy).toBe("green");
  });

  it("never makes subjective green", () => {
    const all = new Set<ZkTlsField>(["category", "variant", "return_policy"]);
    expect(
      fieldColors(mandate, { merchantSignedCheckout: true, zkTlsFields: all }).subjective,
    ).toBe("gray");
  });
});
