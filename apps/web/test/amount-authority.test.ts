import { describe, expect, test } from "vitest";
import { type AmountAuthority, authorityLabel } from "../components/amount-authority";

const of = (a: Omit<AmountAuthority, "crossCheck">) =>
  authorityLabel({ crossCheck: "agrees", ...a }, "Alfred");

describe("authorityLabel", () => {
  test("names what decided the amount, as the receipt and the verifier say it", () => {
    expect(of({ authority: "paypal_order", via: "own" })).toEqual({
      label: "Amount confirmed with PayPal",
      detail: "Read from PayPal's Orders API: this is Keelson's own PayPal order",
      confirmed: true,
    });
    expect(of({ authority: "paypal_order", via: "partner" }).detail).toBe(
      "Read from PayPal's Orders API with Alfred's permission",
    );
    expect(of({ authority: "merchant_signed_cart", via: "ucp" })).toMatchObject({
      label: "Amount signed by the store",
      detail: "Alfred signed this cart; PayPal's checkout showed the same total",
    });
    expect(of({ authority: "user_confirmed" })).toEqual({
      label: "Amount you confirmed",
      detail: "You confirmed it with your passkey on PayPal's checkout",
      confirmed: true,
    });
  });

  test("the checkout page alone is never called confirmed", () => {
    const page = of({ authority: "checkout_page" });
    expect(page).toEqual({
      label: "Amount not confirmed",
      detail: "Read from PayPal's checkout page only",
      confirmed: false,
    });
    expect(`${page.label} ${page.detail}`).not.toMatch(/(?<!not )confirmed/);
  });
});
