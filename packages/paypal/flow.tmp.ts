import { chromium } from "playwright";

const S = process.env.SHOTS!;
const steps: string[] = JSON.parse(process.argv[2]!);
const commit = process.argv[3] === "commit";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ locale: "en-US", storageState: `${S}/state.json` });
const page = await ctx.newPage();
page.setDefaultTimeout(30_000);
const dump = async (name: string) => {
  await page.screenshot({ path: `${S}/${name}.png`, fullPage: true });
  const items = await page
    .locator("button, a, [role=radio], input, label, h1, h2, h3, legend, textarea, select")
    .evaluateAll((els) =>
      els.map(
        (e) =>
          `${e.tagName}${(e as HTMLInputElement).type ? "[" + (e as HTMLInputElement).type + "]" : ""}:${((e as HTMLElement).innerText || (e as HTMLInputElement).value || e.getAttribute("aria-label") || e.getAttribute("name") || "").trim().replace(/\s+/g, " ").slice(0, 90)}`,
      ),
    );
  const skip =
    /^(A:(Finances|Send|Rewards|Wallet|Help|Contact|Security|Fees|Privacy|Legal|Policy|Manage|Log Out|LOG OUT|Settings|Home|Activity|Notifications|View Messages|0\(|Take our)|BUTTON:(Notifications|Inbox|Menu|Yes, I accept|Close))/;
  console.log(
    "==",
    name,
    page.url(),
    "\n",
    [...new Set(items)]
      .filter((t) => !skip.test(t))
      .slice(0, 70)
      .join("\n "),
  );
};
try {
  await page.goto("https://www.sandbox.paypal.com/resolutioncenter");
  await page.waitForLoadState("networkidle").catch(() => {});
  for (const [i, s] of steps.entries()) {
    const [kind, ...rest] = s.split("|");
    const arg = rest.join("|");
    if (kind === "click") await page.getByText(arg, { exact: false }).first().click();
    else if (kind === "role") {
      const [r, n] = arg.split("=");
      await page
        .getByRole(r as any, { name: n })
        .first()
        .click();
    } else if (kind === "check") await page.getByLabel(arg).first().check({ force: true });
    else if (kind === "fill") {
      const [l, v] = arg.split("=");
      await page.getByLabel(l!).first().fill(v!);
    } else if (kind === "filltext") await page.locator("textarea").first().fill(arg);
    else if (kind === "submit") {
      if (!commit) break;
      await page.getByRole("button", { name: arg }).first().click();
    }
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(2500);
  }
  await dump("flow");
} catch (e) {
  await dump("error");
  console.log(String(e).slice(0, 400));
} finally {
  await browser.close();
}
