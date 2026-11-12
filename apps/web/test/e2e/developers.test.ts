import AxeBuilder from "@axe-core/playwright";
import { type Browser, chromium, devices, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { serveOut } from "./static";

let browser: Browser;
let site: Awaited<ReturnType<typeof serveOut>>;
beforeAll(async () => {
  site = await serveOut();
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await site?.close();
});

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const now = () => new Date().toISOString();
const SESSION = () => ({
  session: {
    id: "s",
    userId: "u",
    token: "t",
    expiresAt: now(),
    createdAt: now(),
    updatedAt: now(),
  },
  user: {
    id: "u",
    name: "Ana",
    email: "a@example.test",
    emailVerified: false,
    createdAt: now(),
    updatedAt: now(),
  },
});
const app = (mandate: boolean) => ({
  agentId: "351",
  clientId: "cli",
  name: "Quickstart",
  operator: "Keelson shopping agent",
  connected: true,
  mandate: mandate
    ? {
        id: "01M7MANDATE000000000000000",
        state: "ACTIVE",
        currency: "USD",
        maxMinor: "10000",
        remainingMinor: "10000",
        expiresAt: now(),
        merchants: ["RunFast"],
      }
    : null,
  lastActivityAt: now(),
});

async function open(
  state: { signedIn: boolean; agents?: unknown[]; rows?: unknown[] },
  device = { viewport: { width: 1440, height: 900 } },
) {
  const context = await browser.newContext({
    ...device,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  await context.route("https://api.keelson.finance/**", async (route) => {
    const url = new URL(route.request().url());
    const headers = {
      "access-control-allow-origin": site.base,
      "access-control-allow-credentials": "true",
    };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const body =
      url.pathname === "/api/auth/get-session"
        ? state.signedIn
          ? SESSION()
          : null
        : url.pathname === "/v1/agents"
          ? { agents: state.agents ?? [] }
          : url.pathname === "/v1/activity"
            ? { rows: state.rows ?? [] }
            : undefined;
    if (body === undefined) return route.abort("connectionrefused");
    return route.fulfill({ headers, contentType: "application/json", body: JSON.stringify(body) });
  });
  const page = await context.newPage();
  await page.goto(`${site.base}/developers/`);
  await page.getByRole("heading", { level: 1, name: "Build with Keelson" }).waitFor();
  return { context, page };
}

const done = (page: Page) => page.getByRole("list", { name: "Steps" }).getByLabel("Done").count();

async function axe(page: Page) {
  await page.waitForTimeout(300);
  const { violations } = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(",")}`)).toEqual([]);
}

describe("the developers page", () => {
  test("signed out, it shows the five steps and asks to sign in", async () => {
    const { context, page } = await open({ signedIn: false });
    expect(await page.getByRole("list", { name: "Steps" }).getByRole("listitem").count()).toBe(5);
    expect(await done(page)).toBe(0);
    await page.getByRole("link", { name: "Sign in", exact: true }).waitFor();
    await axe(page);
    await context.close();
  });

  test("each step ticks as the user's code runs, and the receipt links to the verifier", async () => {
    const fresh = await open({ signedIn: true });
    await fresh.page.waitForTimeout(500);
    expect(await done(fresh.page)).toBe(0);
    await fresh.context.close();

    const mandate = await open({ signedIn: true, agents: [app(true)] });
    await expect.poll(() => done(mandate.page)).toBe(3);
    await mandate.context.close();

    const bought = await open({
      signedIn: true,
      agents: [app(true)],
      rows: [{ purchaseId: "01M75ZQSJDFE8K76ZKZT08X1B2", tone: "good" }],
    });
    await expect.poll(() => done(bought.page)).toBe(5);
    expect(
      await bought.page.getByRole("link", { name: /^Verify 01M75ZQS/ }).getAttribute("href"),
    ).toBe("https://verify.keelson.finance/?id=01M75ZQSJDFE8K76ZKZT08X1B2");
    await axe(bought.page);
    await bought.context.close();
  });

  test("the language toggle swaps every snippet, and Copy for AI copies the page", async () => {
    const { context, page } = await open({ signedIn: false });
    await page.getByRole("button", { name: "Python" }).click();
    await page.getByText("pip install keelson-finance").waitFor();
    await page.getByRole("button", { name: "Copy for AI" }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain("# Build with Keelson");
    expect(copied).toContain("keelson login");
    await context.close();
  });

  test.each([
    ["desktop", { viewport: { width: 1440, height: 900 } }],
    ["phone", devices["Pixel 7"]],
    ["a 390 px window", { viewport: { width: 390, height: 844 } }],
  ])("on %s no code line is clipped and no copy button covers code", async (_, device) => {
    const { context, page } = await open({ signedIn: false }, device);
    for (const language of ["TypeScript", "Python"]) {
      await page.getByRole("button", { name: language, exact: true }).click();
      const blocks = await page.locator("pre").evaluateAll((pres) =>
        pres.map((pre) => {
          const button = pre.parentElement?.querySelector("button")?.getBoundingClientRect();
          const box = pre.getBoundingClientRect();
          return {
            clipped: pre.scrollWidth > pre.clientWidth + 1,
            covered: Boolean(button && button.left < box.right - 1 && button.top < box.bottom),
          };
        }),
      );
      expect(blocks.length).toBeGreaterThan(5);
      expect(blocks.filter((b) => b.clipped || b.covered)).toEqual([]);
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await context.close();
  });

  test("one shell, and the full docs linked from the header and every step", async () => {
    const { context, page } = await open({ signedIn: true });
    expect(await page.locator("main").count()).toBe(1);
    expect(await page.getByRole("link", { name: "Full docs" }).getAttribute("href")).toBe(
      "https://docs.keelson.finance",
    );
    const steps = page.getByRole("link", { name: / in the docs$/ });
    expect(await steps.count()).toBe(5);
    for (const href of await steps.evaluateAll((as) => as.map((a) => a.getAttribute("href")))) {
      expect(href).toMatch(/^https:\/\/docs\.keelson\.finance\/sdk\//);
    }
    await context.close();
  });
});
