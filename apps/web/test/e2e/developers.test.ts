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
    await page.getByRole("link", { name: "Sign in" }).waitFor();
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

  test("on a phone the steps stack without scrolling sideways", async () => {
    const { context, page } = await open({ signedIn: false }, devices["Pixel 7"]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await context.close();
  });
});
