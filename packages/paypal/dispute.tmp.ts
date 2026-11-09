import { chromium } from "playwright";

const S = process.env.SHOTS!;
const step = process.argv[2] ?? "explore";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  locale: "en-US",
  storageState: step === "login" ? undefined : `${S}/state.json`,
});
const page = await ctx.newPage();
page.setDefaultTimeout(45_000);
const dump = async (name: string) => {
  await page.screenshot({ path: `${S}/${name}.png`, fullPage: true });
  const items = await page
    .locator("button, a, [role=radio], label, h1, h2, h3")
    .evaluateAll((els) =>
      els
        .map(
          (e) =>
            `${e.tagName}:${(e as HTMLElement).innerText?.trim().replace(/\s+/g, " ").slice(0, 80)}`,
        )
        .filter((t) => t.length > 4),
    );
  console.log(name, page.url(), "\n", [...new Set(items)].slice(0, 80).join("\n "));
};
try {
  if (step === "login") {
    await page.goto("https://www.sandbox.paypal.com/signin");
    await page
      .getByRole("textbox", { name: "Email or mobile number" })
      .fill(process.env.PAYPAL_SANDBOX_BUYER_EMAIL!);
    await page.getByRole("button", { name: "Next" }).click();
    await page
      .getByLabel("Password", { exact: true })
      .fill(process.env.PAYPAL_SANDBOX_BUYER_PASSWORD!);
    await page.getByRole("button", { name: "Log In" }).click();
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(5000);
    await ctx.storageState({ path: `${S}/state.json` });
    await dump("after-login");
  } else {
    await page.goto(process.argv[3]!);
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(4000);
    await dump(step);
  }
} finally {
  await browser.close();
}
