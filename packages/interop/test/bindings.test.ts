import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { BindingError, checkBinding, EXPORT_BINDINGS, transform } from "../src/bindings.ts";
import { purchaseFacts, statementFacts } from "../src/facts.ts";
import { ALLOW_PAYPAL, alibi, DENY_PAYPAL } from "./fixtures.ts";

const facts = statementFacts(purchaseFacts(alibi(ALLOW_PAYPAL)));
const statement = "0oRYI6MBJgRUAA";

const codeOf = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    if (e instanceof BindingError) return e.code;
    throw e;
  }
  return undefined;
};

describe("statementFacts", () => {
  test("projects the countersigned facts as leg A compares them", () => {
    const cs = alibi(ALLOW_PAYPAL).tee.countersign;
    expect(facts).toEqual({
      request_id: cs.requestId,
      mandate_hash: cs.mandateHash,
      cart_hash: cs.cartHash,
      agent_id: "351",
      merchant_id: cs.merchantId,
      amount_minor: 100,
      currency: 840,
      decision: "allow",
      issued_at: 1794219430,
    });
    expect(statementFacts(purchaseFacts(alibi(DENY_PAYPAL))).decision).toBe("deny");
  });
});

const PROFILE = "keelson.export/1";
const bound = (f = facts, st = statement) => ({
  keelson: { profile: PROFILE, statement: st, facts: f },
});

describe("checkBinding", () => {
  test("accepts a payload that carries the statement and its facts", () => {
    expect(codeOf(() => checkBinding("JWT", bound(), facts, statement))).toBeUndefined();
  });

  test("refuses a fact that differs from the statement's", () => {
    const payload = bound({ ...facts, amount_minor: 101 });
    expect(codeOf(() => checkBinding("JWT", payload, facts, statement))).toBe("export.facts");
  });

  test("refuses a payload that names another statement", () => {
    const payload = bound(facts, "other");
    expect(codeOf(() => checkBinding("JWT", payload, facts, statement))).toBe("export.statement");
  });

  test("refuses a typ the table does not know", () => {
    expect(
      codeOf(() => checkBinding("nope", { keelson: { statement, facts } }, facts, statement)),
    ).toBe("export.typ");
  });
});

describe("transforms", () => {
  test("map a fact to the form each standard states it in", () => {
    expect(transform("Minor", 10000, facts)).toBe(10000);
    expect(transform("Major", 10000, facts)).toBe(100);
    expect(transform("UpperCurrency", 840, facts)).toBe("USD");
    expect(transform("LowerCurrency", 840, facts)).toBe("usd");
    expect(transform("StatusOfDecision", "deny", facts)).toBe("Error");
    expect(transform("StatusOfDecision", "allow", facts)).toBe("Success");
    expect(
      transform(
        "UlidOfRequest",
        "0x0000000000000000000000000000000001a1bfcfca3cc623777ab2568f5a6768",
        facts,
      ),
    ).toBe("01M6ZWZJHWRRHQEYNJAT7NMSV8");
  });
});

test("bindings.json is the table, for the engine", () => {
  const json = JSON.parse(readFileSync(new URL("../bindings.json", import.meta.url), "utf8"));
  expect(json).toEqual(
    Object.entries(EXPORT_BINDINGS).map(([profile, { typ, rows }]) => ({ profile, typ, rows })),
  );
});
