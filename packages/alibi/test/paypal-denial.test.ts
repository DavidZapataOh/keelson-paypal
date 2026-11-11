import { describe, expect, test } from "vitest";
import { paypalDenial } from "../src/verify/checks/util.ts";

const PAYPAL_BIT = String(2 ** 31);
const trace = {
  decision: "deny",
  context: {},
  fields: [],
  fired: [],
  errors: ["paypal.insufficient"],
};
const c = { decision: "2", failedFieldsMask: PAYPAL_BIT };

describe("a DENY leg A gave on its PayPal read, before any policy ran", () => {
  test("is recognized by its empty context, its one PayPal reason and the mask's PayPal bit", () => {
    expect(paypalDenial(trace, c)).toBe("paypal.insufficient");
  });

  test.each([
    ["an ALLOW", { ...trace, decision: "allow" }, c],
    ["a countersigned ALLOW", trace, { ...c, decision: "1" }],
    ["a trace with a context", { ...trace, context: { total_minor: 590 } }, c],
    ["a trace with fields", { ...trace, fields: [{ id: "amount" }] }, c],
    ["a reason that is not PayPal's", { ...trace, errors: ["cedar.error"] }, c],
    ["a mask without the PayPal bit", trace, { ...c, failedFieldsMask: "0" }],
  ])("is not %s", (_, t, cs) => {
    expect(paypalDenial(t, cs)).toBeUndefined();
  });
});
