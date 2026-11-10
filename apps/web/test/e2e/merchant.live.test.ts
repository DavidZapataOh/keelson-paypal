import { chromium } from "playwright";
import { privateKeyToAccount } from "viem/accounts";
import { expect, test } from "vitest";

// The deployed console, signed in by the merchant's own settlement wallet: a browser wallet that
// holds `KEELSON_MERCHANT_KEY` signs the EIP-4361 sign-in and the EIP-712 settlement choice.
const ORIGIN = process.env.MERCHANT_LIVE_ORIGIN;
const KEY = process.env.KEELSON_MERCHANT_KEY as `0x${string}` | undefined;
/** The PayPal account won disputes should pay; set through the console when it differs. */
const RECEIVER = process.env.MERCHANT_PAYPAL_RECEIVER;
/** Asks the console's agents the forensics question; it spends model budget. */
const ASK = process.env.MERCHANT_LIVE_ASK;

test.runIf(ORIGIN && KEY)(
  "the merchant signs in, sets its settlement and gets the forensics answer",
  async () => {
    const account = privateKeyToAccount(KEY as `0x${string}`);
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.exposeFunction("__wallet", async (method: string, params: unknown[]) => {
      if (method === "eth_requestAccounts") return [account.address];
      if (method === "personal_sign") return account.signMessage({ message: params[0] as string });
      if (method === "eth_signTypedData_v4") {
        const { types, ...typed } = JSON.parse(params[1] as string);
        const { EIP712Domain: _, ...rest } = types;
        return account.signTypedData({ ...typed, types: rest });
      }
      throw new Error(`unsupported ${method}`);
    });
    await context.addInitScript(() => {
      const w = window as unknown as {
        ethereum: unknown;
        __wallet: (m: string, p: unknown[]) => Promise<unknown>;
      };
      w.ethereum = {
        request: ({ method, params }: { method: string; params?: unknown[] }) =>
          w.__wallet(method, params ?? []),
      };
    });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/merchant/`);
    await page.getByRole("button", { name: "Sign in with wallet" }).click();
    const summary = page.getByTestId("settlement-summary");
    await summary.waitFor({ timeout: 30_000 });
    if (RECEIVER && !(await summary.textContent())?.includes(RECEIVER)) {
      await page.getByRole("button", { name: "Change" }).click();
      await page.getByRole("radio", { name: /PayPal Payout/ }).check();
      await page.getByRole("textbox", { name: "PayPal account" }).fill(RECEIVER);
      await page.getByRole("button", { name: "Sign in wallet" }).click();
      await expect.poll(() => summary.textContent(), { timeout: 30_000 }).toContain(RECEIVER);
    }
    await page.getByRole("button", { name: "Forensics" }).click();
    await page.getByRole("button", { name: /^Price \(cart total\)$/ }).waitFor({ timeout: 60_000 });
    if (ASK) {
      const box = page.getByPlaceholder(/Ask the AI Assistant/);
      await box.fill(ASK);
      await box.press("Enter");
      // The forensics agent filters the page to the price field: the matrix keeps one row.
      await expect
        .poll(() => page.locator(".keelson-matrix tbody tr").count(), { timeout: 240_000 })
        .toBe(1);
    }
    await browser.close();
  },
  360_000,
);
