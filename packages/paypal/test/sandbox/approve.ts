import { sha256, toHex, toPayPalValue } from "@keelson/core";
import {
  type Money,
  type Order,
  PaypalExperienceLandingPage,
  PaypalExperienceUserAction,
  PaypalWalletContextShippingPreference,
  type PaypalWalletExperienceContext,
} from "@paypal/paypal-server-sdk";
import { chromium, type Page } from "playwright";

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

/** The consent buttons PayPal shows for `user_action: PAY_NOW`. */
const CONSENT = /^(Complete Purchase|Pay Now)$/;
const CHALLENGE = /captcha|security check|security challenge|confirm it's you|verify it's you/i;

export const usd = (minor: bigint): Money => ({
  currencyCode: "USD",
  value: toPayPalValue({ currency: "USD", minor }),
});

/** A `PayPal-Request-Id` derived from the order and the operation, so retries stay idempotent. */
export function operationRequestId(orderId: string, operation: "authorize" | "void"): string {
  return toHex(sha256(new TextEncoder().encode(`${operation}:${orderId}`))).slice(2, 38);
}

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

    let step = "login";
    try {
      await page.goto(approveUrl);
      await page.getByRole("textbox", { name: "Email or mobile number" }).fill(email);
      await page.getByRole("button", { name: "Next" }).click();
      step = "password";
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Log In" }).click();
      step = "consent";
      await page.getByRole("button", { name: CONSENT }).click();
      step = "return";
      await page.waitForURL((url) => url.href.startsWith(RETURN_URL));
    } catch (cause) {
      throw await approvalError(page, step, cause);
    }
  } finally {
    await browser.close();
  }
}

async function approvalError(page: Page, step: string, cause: unknown): Promise<Error> {
  const url = new URL(page.url());
  const title = await page.title().catch(() => "");
  const challenged =
    (await page
      .getByText(CHALLENGE)
      .count()
      .catch(() => 0)) > 0;
  const what = challenged ? "a challenge or captcha" : `no ${step} step`;
  return new Error(
    `PayPal showed ${what} at ${url.origin}${url.pathname} ("${title}"); rerun with PLAYWRIGHT_HEADED=1 to see it`,
    { cause },
  );
}
