import { describe, expect, test } from "vitest";
import { allowedPayees, type Mandate, payeeAllowed } from "../src/index.ts";

const withPayees = (ids: string[]) =>
  ({
    payment: {
      constraints: [
        { type: "payment.budget", max: 800, currency: "USD" },
        ...(ids.length
          ? [
              {
                type: "payment.allowed_payees",
                allowed: ids.map((id) => ({ paypal_merchant_id: id })),
              },
            ]
          : []),
      ],
    },
  }) as unknown as Pick<Mandate, "payment">;

describe("the PayPal merchants a mandate allows paying", () => {
  test("are the merchant ids its allowed payees name", () => {
    expect(allowedPayees(withPayees(["DZ93UDZC2BKLE", "MERCH7XK2Q9LD"]))).toEqual([
      "DZ93UDZC2BKLE",
      "MERCH7XK2Q9LD",
    ]);
    expect(payeeAllowed(allowedPayees(withPayees(["DZ93UDZC2BKLE"])), "DZ93UDZC2BKLE")).toBe(true);
  });

  test("another merchant, or none named, is not allowed: a placeholder is no merchant id", () => {
    expect(payeeAllowed(allowedPayees(withPayees(["MERCH7XK2Q9LD"])), "DZ93UDZC2BKLE")).toBe(false);
    expect(allowedPayees(withPayees(["unknown"]))).toEqual([]);
    expect(payeeAllowed(allowedPayees(withPayees(["unknown"])), "DZ93UDZC2BKLE")).toBe(false);
    expect(payeeAllowed(allowedPayees(withPayees([])), "DZ93UDZC2BKLE")).toBe(false);
  });
});
