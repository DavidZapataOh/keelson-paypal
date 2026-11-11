import { describe, expect, test } from "vitest";
import { pageAmounts } from "../src/gate.ts";

const usd = (minor: number) => ({ currency: "USD", minor });

describe("amounts as stores and PayPal write them", () => {
  test.each([
    ["Total $2.95", [usd(295)]],
    ["Total USD $2.95", [usd(295)]],
    ["$2.95 USD", [usd(295)]],
    ["Pagar 2,95 US$", [usd(295)]],
    ["Total US$2,95", [usd(295)]],
    ["Total US$ 2,95", [usd(295)]],
    ["2,95 US$", [usd(295)]],
    ["US$ 2,95", [usd(295)]],
    ["USD 2.95", [usd(295)]],
    ["2,95 $", [usd(295)]],
    ["$1,234.56", [usd(123_456)]],
    ["1.234,56 US$", [usd(123_456)]],
    ["$5", [usd(500)]],
    ["Total 2,95 €", [{ currency: "EUR", minor: 295 }]],
  ])("%s", (text, want) => {
    const got = pageAmounts(text);
    expect(got.length).toBeGreaterThan(0);
    expect([...new Map(got.map((a) => [`${a.currency}${a.minor}`, a])).values()]).toEqual(want);
  });

  test("text without a currency carries no amount", () => {
    expect(pageAmounts("Revisar pedido 2,95 · 3 items · 2026")).toEqual([]);
  });

  test("a line price and a larger total are both read", () => {
    const minors = pageAmounts("The Change US$2,95\nImpuestos US$0,18\nTotal US$3,13").map(
      (a) => a.minor,
    );
    expect(Math.max(...minors)).toBe(313);
  });
});
