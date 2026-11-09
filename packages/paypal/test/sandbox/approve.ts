import { toPayPalValue } from "@keelson/core";
import {
  type Money,
  PaypalExperienceLandingPage,
  PaypalExperienceUserAction,
  PaypalWalletContextShippingPreference,
  type PaypalWalletExperienceContext,
} from "@paypal/paypal-server-sdk";
import { CANCEL_URL, RETURN_URL } from "../../src/testing.ts";

/** `payment_source.paypal.experience_context` for orders the sandbox buyer approves. */
export const experienceContext: PaypalWalletExperienceContext = {
  returnUrl: RETURN_URL,
  cancelUrl: CANCEL_URL,
  userAction: PaypalExperienceUserAction.PayNow,
  shippingPreference: PaypalWalletContextShippingPreference.NoShipping,
  landingPage: PaypalExperienceLandingPage.Login,
  locale: "en-US",
};

export const usd = (minor: bigint): Money => ({
  currencyCode: "USD",
  value: toPayPalValue({ currency: "USD", minor }),
});
