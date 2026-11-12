import type { Order } from "@paypal/paypal-server-sdk";
import { chromium, type Page } from "playwright";

/** Where sandbox orders return after approval; the page is never loaded for real. */
export const RETURN_URL = "https://keelson.finance/return";
export const CANCEL_URL = "https://keelson.finance/cancel";

/** The consent buttons PayPal shows for `user_action: PAY_NOW` and for saving PayPal. */
const CONSENT =
  /^(Complete Purchase|Pay Now|Agree and Continue|Agree & Continue|Save and Continue)$/;
const CHALLENGE = /captcha|security check|security challenge|confirm it's you|verify it's you/i;

/** The order's `payer-action` (or `approve`) link. */
export function payerActionUrl(order: Order): string {
  const link = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve");
  if (!link) throw new Error(`order ${order.id} has no payer-action link`);
  return link.href;
}

function buyer(): { email: string; password: string } {
  const email = process.env.PAYPAL_SANDBOX_BUYER_EMAIL;
  const password = process.env.PAYPAL_SANDBOX_BUYER_PASSWORD;
  if (!email || !password) {
    throw new Error("PAYPAL_SANDBOX_BUYER_EMAIL and PAYPAL_SANDBOX_BUYER_PASSWORD are required");
  }
  return { email, password };
}

/**
 * Logs in as the sandbox buyer on a page that shows PayPal's login (a redirect or the
 * JS SDK popup) and gives consent.
 */
export async function approveOnPage(page: Page): Promise<void> {
  const { email, password } = buyer();
  let step = "login";
  try {
    await page.getByRole("textbox", { name: "Email or mobile number" }).fill(email);
    await page.getByRole("button", { name: "Next" }).click();
    step = "password";
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Log In" }).click();
    step = "consent";
    await page.getByRole("button", { name: CONSENT }).click();
  } catch (cause) {
    throw await approvalError(page, step, cause);
  }
}

/**
 * Logs in as the sandbox buyer, approves the order and waits for its return URL, which must be
 * the order's `return_url` or start with it.
 */
export async function approveOrder(
  approveUrl: string,
  returnUrl: string = RETURN_URL,
): Promise<void> {
  buyer();
  const browser = await chromium.launch({ headless: process.env.PLAYWRIGHT_HEADED !== "1" });
  try {
    const context = await browser.newContext({ locale: "en-US" });
    // The return page is ours; only the redirect to it matters.
    await context.route(`${new URL(returnUrl).origin}/**`, (route) =>
      route.fulfill({ status: 200, contentType: "text/plain", body: "" }),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(45_000);
    try {
      await page.goto(approveUrl);
    } catch (cause) {
      throw await approvalError(page, "login", cause);
    }
    await approveOnPage(page);
    try {
      await page.waitForURL((url) => url.href.startsWith(returnUrl));
    } catch (cause) {
      throw await approvalError(page, "return", cause);
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
