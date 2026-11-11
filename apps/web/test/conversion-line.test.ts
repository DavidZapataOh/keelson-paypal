import type { Conversion } from "@keelson/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { ConversionLine } from "../components/conversion-line";

const conversion: Conversion = {
  v: "keelson.conversion/1",
  merchant: { currency: "USD", value: "2.95" },
  buyer: { currency: "COP", value: "10231" },
  rate: "3468.14",
  reference: {
    rate: "3276.876985",
    provider: "ExchangeRate-API",
    source: "https://open.er-api.com/v6/latest/USD",
    as_of: "2026-11-11T00:02:32.000Z",
  },
  spread_bps: 584,
  max_spread_bps: 750,
  locale: "es-CO",
};

test("a converted charge reads as the buyer paid it, with PayPal's spread and the cap", () => {
  const html = renderToStaticMarkup(createElement(ConversionLine, { conversion }));
  expect(html).toContain("Paid 10.231 COP (USD 2.95 at 3.468,14)");
  expect(html).toContain("PayPal&#x27;s rate is 5.84% from the mid-market rate");
  expect(html).toContain("the mandate allows 7.5%");
  expect(html).toContain("Rates By Exchange Rate API");
});
