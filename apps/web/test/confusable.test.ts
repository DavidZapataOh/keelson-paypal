import { describe, expect, test } from "vitest";
import { confusableWarning, restrictionLevel, skeleton } from "../lib/confusable";
import { CONFUSABLES } from "../lib/confusables.generated";

describe("names that pass for another (UTS #39)", () => {
  test("a Latin name with one Cyrillic letter warns, and shows what it looks like", () => {
    expect(restrictionLevel("PаyPal")).toBe("minimally-restrictive");
    expect(confusableWarning("PаyPal")).toEqual({ lookalike: "PayPal" });
    expect(confusableWarning("PаyPal Store")).toEqual({ lookalike: "PayPal Store" });
  });

  test("a Greek capital Rho in a Latin name warns", () => {
    expect(confusableWarning("Ρaypal")).toEqual({ lookalike: "Paypal" });
  });

  test("a whole name in fullwidth or Cyrillic lookalikes warns", () => {
    expect(confusableWarning("ＰａｙＰａｌ")).toEqual({
      lookalike: "PayPal",
    });
    expect(confusableWarning("РауРаl")).not.toBeNull();
  });

  test("accents, other scripts and Japanese names are left alone", () => {
    expect(confusableWarning("Café Olé")).toBeNull();
    expect(confusableWarning("東京ストア")).toBeNull();
    // Han and Katakana resolve to one writing system (Jpan).
    expect(restrictionLevel("東京ストア")).toBe("single-script");
    expect(restrictionLevel("Tokyo 東京ストア")).toBe("highly-restrictive");
    expect(confusableWarning("Москва")).toBeNull();
    expect(confusableWarning("Claude")).toBeNull();
    expect(restrictionLevel("Claude")).toBe("ascii");
  });

  test("the skeleton maps through the confusables data and normalizes", () => {
    expect(skeleton("PаyPal")).toBe("PayPal");
    expect(skeleton("Café")).toBe("Café");
  });

  test("the table is the ASCII-prototype subset, small enough to ship", () => {
    const size = Object.keys(CONFUSABLES).length;
    expect(size).toBeGreaterThan(1_000);
    expect(size).toBeLessThan(2_500);
    expect(CONFUSABLES["а"]).toBe("a");
  });
});
