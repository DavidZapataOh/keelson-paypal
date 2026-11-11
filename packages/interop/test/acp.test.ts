import { describe, expect, it } from "vitest";
import { acpDelegation } from "../src/acp.ts";
import { errors } from "./schemas.ts";

/** The `$id` the 2026-04-17 bundle declares. */
const ACP = "https://example.com/schemas/delegate-payment/bundle.schema.json";

describe("ACP 2026-04-17 allowance", () => {
  const base = {
    currency: "USD",
    maxAmountMinor: 10_000,
    remainingMinor: 6_000,
    exp: 1_794_600_000,
    now: 1_794_219_430,
    checkoutSessionId: "8MY937060S1606416",
    merchantId: "A4WCRYD5EYDF2",
    alibiId: "01M6ZWZJHWRRHQEYNJAT7NMSV8",
  };

  it("caps at the smaller of the per-purchase cap and the budget left, in lowercase currency", () => {
    const { allowance, metadata } = acpDelegation(base);
    expect(allowance).toEqual({
      reason: "one_time",
      max_amount: 6_000,
      currency: "usd",
      checkout_session_id: "8MY937060S1606416",
      merchant_id: "A4WCRYD5EYDF2",
      expires_at: "2026-11-09T10:32:10Z",
    });
    expect(metadata).toEqual({ keelson_alibi: "01M6ZWZJHWRRHQEYNJAT7NMSV8" });
  });

  it("expires with the mandate when it ends within 15 minutes", () => {
    const { allowance } = acpDelegation({ ...base, exp: base.now + 60 });
    expect(allowance.expires_at).toBe(
      new Date((base.now + 60) * 1000).toISOString().replace(".000Z", "Z"),
    );
  });

  it("validates against the Allowance schema and the request's metadata", () => {
    const { allowance, metadata } = acpDelegation(base);
    expect(errors(`${ACP}#/$defs/Allowance`, allowance)).toEqual([]);
    expect(errors(`${ACP}#/$defs/DelegatePaymentRequest/properties/metadata`, metadata)).toEqual(
      [],
    );
  });
});
