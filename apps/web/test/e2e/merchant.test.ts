import AxeBuilder from "@axe-core/playwright";
import { type Browser, type BrowserContext, chromium, devices, type Page } from "playwright";
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
  test("the console asks for the settlement wallet and states what is signed", async () => {
    const context = await browser.newContext(VIEWPORTS[kind]);
    await context.route(`${API}/**`, (route) => route.abort("connectionrefused"));
    const page = await context.newPage();
    await page.goto(`${site.base}/merchant/`);
    await page.getByRole("heading", { level: 1, name: "Merchant console" }).waitFor();
    expect(await page.getByRole("button", { name: "Sign in with wallet" }).isVisible()).toBe(true);
    expect(await page.getByText("EIP-4361").isVisible()).toBe(true);
    // No wallet in this browser: the console says so instead of failing silently.
    await page.getByRole("button", { name: "Sign in with wallet" }).click();
    await page.getByText("No browser wallet found.").waitFor();
    const { violations } = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= screen.width)).toBe(
      true,
    );
    await context.close();
  });
});

// The 250k-row budget: a generated table the size of a large merchant's year of agent
// evaluations, loaded into the same Studio build the console ships.
const ROWS = 250_000;
const AGENTS = [
  "claude-haiku-4-5 · vulnerable",
  "claude-sonnet-5-5 · guarded",
  "Agent #351",
  "Agent #412",
  "Agent #518",
  "Agent #733",
];
const FIELDS = ["amount", "budget", "variant", "category", "merchant", "quantity", "returns"];

function evaluations() {
  const columns = [
    "source",
    "evaluation_id",
    "at",
    "agent",
    "operator",
    "field",
    "color",
    "failed",
    "decision",
    "attack_class",
    "dispute_id",
    "liable",
  ];
  const start = Date.UTC(2026, 0, 1);
  const rows: unknown[][] = [];
  for (let i = 0; i < ROWS; i++) {
    const agent = AGENTS[i % AGENTS.length] as string;
    const field = FIELDS[i % FIELDS.length] as string;
    // A deterministic pattern: some agents fail some fields far more often.
    const failed = (i * 2654435761) % 97 < (agent.includes("vulnerable") ? 30 : 3) ? 1 : 0;
    rows.push([
      i % 3 ? "purchase" : "red-team",
      `E${i.toString(36).padStart(8, "0")}`,
      new Date(start + i * 60_000).toISOString(),
      agent,
      "351",
      field,
      "green",
      failed,
      failed ? "deny" : "allow",
      null,
      null,
      null,
    ]);
  }
  return { columns, rows };
}

async function signedInConsole(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(VIEWPORTS.desktop);
  const body = JSON.stringify(evaluations());
  const merchant = {
    merchant_id: "mrc_runfast",
    name: "RunFast",
    website: "https://store.keelson.finance",
    settlement_address: "0x467D2beBb479D9B80Ab1c461243E05A2b82387d8",
  };
  await context.route(`${API}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (value: unknown) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/v1/merchants/me") return json(merchant);
    if (path.endsWith("/settlement"))
      return json({ rail: "pyusd", paypal_receiver: null, nonce: "0", updated_at: null });
    if (path.endsWith("/disputes")) return json({ disputes: [] });
    if (path.endsWith("/evaluations"))
      return route.fulfill({ contentType: "application/json", body });
    if (path === "/api/auth/get-session") return json(null);
    return route.abort("connectionrefused");
  });
  const page = await context.newPage();
  await page.goto(`${site.base}/merchant/`);
  const forensics = page.getByRole("button", { name: "Forensics" });
  await page.waitForFunction(
    () =>
      !(
        document.querySelector(
          "nav[aria-label='Console pages'] button:last-child",
        ) as HTMLButtonElement
      )?.disabled,
    undefined,
    { timeout: 60_000 },
  );
  await forensics.click();
  await page.getByRole("button", { name: /^Price \(cart total\)$/ }).waitFor({ timeout: 60_000 });
  return { context, page };
}

/**
 * Clicks the button and measures in the page, from the click to the first frame after the
 * evaluations grid below the matrix shows the filtered rows.
 */
async function interaction(page: Page, name: RegExp | string): Promise<number> {
  const button = page.getByRole("button", { name }).first();
  const handle = await button.elementHandle();
  return page.evaluate(async (el) => {
    const grid = () =>
      [...document.querySelectorAll("[role=grid]")].map((e) => e.textContent).join("|");
    const before = grid();
    const t0 = performance.now();
    (el as HTMLElement).click();
    await new Promise<void>((resolve, reject) => {
      setTimeout(() => reject(new Error("the grid did not change within 30 s")), 30_000);
      const check = () => {
        if (grid() !== before) resolve();
        else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    return performance.now() - t0;
  }, handle);
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

// A latency budget, measured on a developer machine: run with `pnpm budgets`.
test.runIf(process.env.KEELSON_BUDGETS)(
  "on 250k rows, cross-filtering the matrix answers in under 100 ms",
  async () => {
    const { context, page } = await signedInConsole();
    const samples: Record<string, number[]> = { row: [], column: [], cell: [], clear: [] };
    for (let i = 0; i < 5; i++) {
      samples.row?.push(await interaction(page, /^Price \(cart total\)$/));
      samples.clear?.push(await interaction(page, /^Price \(cart total\)$/));
      samples.column?.push(await interaction(page, "Agent #351"));
      samples.clear?.push(await interaction(page, "Agent #351"));
      samples.cell?.push(await interaction(page, /^Budget, claude-haiku-4-5 · vulnerable:/));
      samples.clear?.push(await interaction(page, /^Budget, claude-haiku-4-5 · vulnerable:/));
    }
    const medians = Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, median(v)]));
    process.stderr.write(`\n250k rows, median ms: ${JSON.stringify(medians)}\n`);
    for (const ms of Object.values(medians)) expect(ms).toBeLessThan(100);
    await context.close();
  },
  300_000,
);
