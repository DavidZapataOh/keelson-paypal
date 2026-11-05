import {
  type Order,
  PaypalExperienceLandingPage,
  PaypalExperienceUserAction,
  PaypalWalletContextShippingPreference,
  type PaypalWalletExperienceContext,
} from "@paypal/paypal-server-sdk";
import { chromium } from "playwright";

export const RETURN_URL = "https://keelson.finance/return";
export const CANCEL_URL = "https://keelson.finance/cancel";

/** `payment_source.paypal.experience_context` for orders the sandbox buyer approves. */
export const experienceContext: PaypalWalletExperienceContext = {
  returnUrl: RETURN_URL,
  cancelUrl: CANCEL_URL,
  userAction: PaypalExperienceUserAction.PayNow,
  shippingPreference: PaypalWalletContextShippingPreference.NoShipping,
  landingPage: PaypalExperienceLandingPage.Login,
  locale: "en-US",
};

const CONSENT = /^(Complete Purchase|Pay Now|Agree & Continue|Continue to Review Order|Continue)$/;

export function payerActionUrl(order: Order): string {
  const link = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve");
  if (!link) throw new Error(`order ${order.id} has no payer-action link`);
  return link.href;
}

/** Logs in as the sandbox buyer, approves the order and waits for the return URL. */
export async function approveOrder(approveUrl: string): Promise<void> {
  const email = process.env.PAYPAL_SANDBOX_BUYER_EMAIL;
  const password = process.env.PAYPAL_SANDBOX_BUYER_PASSWORD;
  if (!email || !password) {
    throw new Error("PAYPAL_SANDBOX_BUYER_EMAIL and PAYPAL_SANDBOX_BUYER_PASSWORD are required");
  }

  const browser = await chromium.launch({ headless: process.env.PLAYWRIGHT_HEADED !== "1" });
  try {
    const context = await browser.newContext({ locale: "en-US" });
    // The return page is ours; only the redirect to it matters.
    await context.route(`${new URL(RETURN_URL).origin}/**`, (route) =>
      route.fulfill({ status: 200, contentType: "text/plain", body: "" }),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(45_000);

    await page.goto(approveUrl);
    await page.getByRole("textbox", { name: "Email or mobile number" }).fill(email);
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Log In" }).click();
    await page.getByRole("button", { name: CONSENT }).click();
    await page.waitForURL((url) => url.href.startsWith(RETURN_URL));
  } finally {
    await browser.close();
  }
}
