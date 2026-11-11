import {
  type Conversion,
  commitReference,
  describeConversion,
  type FxReference,
  type Json,
  jcs,
  sha256,
  toHex,
} from "@keelson/core";
import { describe, expect, test } from "vitest";
import type { AlibiBundle } from "../src/schema.ts";
import { runCheck } from "../src/verify/check.ts";
import { conversion } from "../src/verify/checks/conversion.ts";

const reference: FxReference = {
  v: "keelson.fx_reference/1",
  provider: "ExchangeRate-API",
  source: "https://open.er-api.com/v6/latest/USD",
  base: "USD",
  as_of: "2026-11-11T00:02:32.000Z",
  fetched_at: "2026-11-11T12:00:00.000Z",
  rates: { COP: "3276.876985", EUR: "0.89871" },
};
const committed = commitReference(reference);
const hash = (v: unknown) => toHex(sha256(new TextEncoder().encode(jcs(v as Json))));

const paid: Conversion = {
  v: "keelson.conversion/1",
  merchant: { currency: "USD", value: "2.95" },
  buyer: { currency: "COP", value: "10231" },
  rate: "3468.14",
  reference: {
    rate: "3276.876985",
    provider: reference.provider,
    source: reference.source,
    as_of: reference.as_of,
  },
  spread_bps: 584,
  max_spread_bps: 750,
  locale: "es-CO",
};

const bundle = (
  o: { conversion?: Conversion; amount?: string; fx?: object; disclosed?: boolean } = {},
) =>
  ({
    type: "application/vnd.keelson.alibi.v1+json",
    tee: { countersign: { amount: o.amount ?? "295", currency: "840" } },
    mandate: { payload_sd: o.fx ? { fx: o.fx } : {} },
    manifest: {
      public: { items: [{ type: "api.fx_reference" }] },
      disclosures: [{ type: "api.fx_reference", content_hash: hash(committed) }],
    },
    ...(o.disclosed === false ? {} : { fx_reference: committed }),
    conversion: o.conversion ?? paid,
  }) as unknown as AlibiBundle;

const run = (b: AlibiBundle) =>
  runCheck(conversion, b, { now: new Date(), expect: undefined, chain: null });

describe("the currency conversion of an Alibi", () => {
  test("passes when the arithmetic, the reference and the cap hold", async () => {
    const c = await run(bundle());
    expect(c.status, c.reason).toBe("pass");
    expect(c.detail).toMatchObject({ buyer: "COP 10231", spread_bps: "584" });
    expect(describeConversion(paid)).toBe("Paid 10.231 COP (USD 2.95 at 3.468,14)");
  });

  test("fails for another amount, rate, reference, spread or cap", async () => {
    expect((await run(bundle({ amount: "300" }))).reason).toMatch(/countersigned amount/);
    expect((await run(bundle({ conversion: { ...paid, rate: "3500.00" } }))).reason).toMatch(
      /PayPal's rate/,
    );
    const otherRef = { ...paid, reference: { ...paid.reference, rate: "3100" } };
    expect((await run(bundle({ conversion: otherRef }))).reason).toMatch(/reference rate/);
    expect((await run(bundle({ conversion: { ...paid, spread_bps: 500 } }))).reason).toMatch(
      /spread is not/,
    );
    expect((await run(bundle({ fx: { max_spread_bps: 500 } }))).reason).toMatch(/cap/);
    const over = { ...paid, max_spread_bps: 500 };
    expect((await run(bundle({ conversion: over, fx: { max_spread_bps: 500 } }))).reason).toMatch(
      /over the mandate's cap/,
    );
  });

  test("is undisclosed without the reference item, and absent without a conversion", async () => {
    expect((await run(bundle({ disclosed: false }))).status).toBe("undisclosed");
    const none = { ...bundle(), conversion: undefined } as unknown as AlibiBundle;
    expect((await run(none)).status).toBe("absent");
  });
});
