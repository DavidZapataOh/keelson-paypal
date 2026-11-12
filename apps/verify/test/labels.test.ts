import { expect, test } from "vitest";
import { amountAuthorityNote, CHECKS } from "../src/labels.ts";

test("the amount authority reads as the app labels it, and says who read PayPal", () => {
  expect(CHECKS["paypal.amount_authority"].label).toBe("Who decided the amount paid on PayPal");
  expect(amountAuthorityNote({ authority: "paypal_order", via: "own", read_by: "api" })).toBe(
    "Amount confirmed with PayPal: PayPal's Orders API, Keelson's own PayPal order, read by Keelson's API",
  );
  expect(amountAuthorityNote({ authority: "user_confirmed", read_by: "api" })).toBe(
    "Amount the user confirmed with the passkey that signed the mandate",
  );
  expect(amountAuthorityNote({ authority: "checkout_page", read_by: "api" })).toBeUndefined();
});
