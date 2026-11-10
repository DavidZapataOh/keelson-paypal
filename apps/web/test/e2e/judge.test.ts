import AxeBuilder from "@axe-core/playwright";
import { type Browser, chromium, devices } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { serveOut } from "./static";

const API = "https://api.keelson.finance";
let site: Awaited<ReturnType<typeof serveOut>>;
let browser: Browser;

beforeAll(async () => {
  site = await serveOut();
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await site?.close();
});

const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 } },
  mobile: devices["Pixel 7"],
} as const;

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

describe.each(Object.keys(VIEWPORTS) as (keyof typeof VIEWPORTS)[])("signed out on %s", (kind) => {
  for (const [path, heading] of [
    ["/judge/", "Judge Keelson in five minutes, on the live system."],
    ["/status/", "Is Keelson up?"],
  ] as const) {
    test(`${path} says what is real and what is sandbox`, async () => {
      const context = await browser.newContext(VIEWPORTS[kind]);
      // With the API unreachable, both pages still render and say so.
      await context.route(`${API}/**`, (route) => route.abort("connectionrefused"));
      const page = await context.newPage();
      await page.goto(`${site.base}${path}`);
      await page.getByRole("heading", { level: 1, name: heading }).waitFor();
      await page.getByRole("cell", { name: "PayPal", exact: true }).waitFor();
      expect(await page.getByRole("cell", { name: "Sandbox" }).first().isVisible()).toBe(true);
      expect(await page.getByRole("cell", { name: "Testnet" }).first().isVisible()).toBe(true);
      if (path === "/judge/") {
        expect(await page.getByRole("button", { name: "Start Judge Mode" }).isEnabled()).toBe(true);
      }
      const { violations } = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await context.close();
    });
  }
});

test("an invite link is forwarded once and leaves the address bar and the history", async () => {
  const invite = "invite-from-the-testing-instructions";
  const context = await browser.newContext(VIEWPORTS.desktop);
  const bodies: unknown[] = [];
  await context.route(`${API}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204 });
    if (request.url().endsWith("/v1/judge/sessions")) {
      bodies.push(request.postDataJSON());
      return route.fulfill({ status: 201, json: { user_id: "judge" } });
    }
    return route.fulfill({ status: 401, contentType: "application/problem+json", json: {} });
  });
  const page = await context.newPage();
  await page.goto(`${site.base}/judge/#invite=${invite}`);
  const start = page.getByRole("button", { name: "Start Judge Mode" });
  await start.waitFor();
  await page.waitForURL(`${site.base}/judge/`);
  await start.click();
  await expect.poll(() => bodies).toEqual([{ invite }]);
  expect(page.url()).not.toContain(invite);
  // The entry before Judge Mode is the blank tab: no history entry kept the invite.
  await page.goBack();
  expect(page.url()).toBe("about:blank");
  await context.close();
});
