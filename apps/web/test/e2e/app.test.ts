import { readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import AxeBuilder from "@axe-core/playwright";
import { type Browser, type BrowserContext, chromium, devices, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { parse } from "yaml";
import { CSP } from "../../csp";

// Serves the static export, which turbo builds before the tests, as the static site does.
const out = fileURLToPath(new URL("../../out", import.meta.url));
const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".riv": "application/octet-stream",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

async function file(path: string): Promise<string | undefined> {
  for (const candidate of [path, join(path, "index.html")]) {
    if ((await stat(candidate).catch(() => undefined))?.isFile()) return candidate;
  }
  return undefined;
}

let server: Server;
let base: string;
let browser: Browser;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const path = await file(
      join(out, decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)),
    );
    if (!path) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[extname(path)] ?? "application/octet-stream",
      "content-security-policy": CSP,
    });
    res.end(await readFile(path));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 860 } },
  mobile: devices["Pixel 7"],
} as const;

/**
 * A signed-out visitor: the API is unreachable from this origin, so the session read fails and
 * the app shows what a visitor without a session sees.
 */
async function visit(kind: keyof typeof VIEWPORTS, path = "/", reducedMotion = false) {
  const context: BrowserContext = await browser.newContext({
    ...VIEWPORTS[kind],
    reducedMotion: reducedMotion ? "reduce" : "no-preference",
  });
  await context.route("https://api.keelson.finance/**", (route) =>
    route.abort("connectionrefused"),
  );
  const page: Page = await context.newPage();
  await page.goto(`${base}${path}`);
  await page.getByRole("heading", { level: 1 }).waitFor();
  return { context, page };
}

describe.each(Object.keys(VIEWPORTS) as (keyof typeof VIEWPORTS)[])("welcome on %s", (kind) => {
  test("says what Keelson does and offers both sign-ins", async () => {
    const { context, page } = await visit(kind);
    await expect(page.getByRole("heading", { level: 1 }).textContent()).resolves.toBe(
      "If your agent goes outside what you signed, someone answers, and it isn't you.",
    );
    expect(await page.getByRole("button", { name: "Continue with PayPal" }).isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "Sign in with a passkey" }).isVisible()).toBe(
      true,
    );
    await context.close();
  });

  test("has no WCAG 2.2 A or AA violations, on every story step", async () => {
    const { context, page } = await visit(kind);
    for (let step = 0; step < 3; step++) {
      const { violations } = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
        .analyze();
      expect(violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
      if (step < 2) await page.getByRole("button", { name: "Next" }).click();
    }
    await context.close();
  });

  test("plays the story with Rive, one artboard per step", async () => {
    const { context, page } = await visit(kind);
    // The runtime loads only once the story is on screen.
    await page.locator("canvas").scrollIntoViewIfNeeded();
    await page.locator("canvas[data-ready=true]").waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("heading", { name: "Every cart is checked before it pays." }).waitFor();
    await page.locator("canvas[data-ready=true]").waitFor({ timeout: 15_000 });
    await context.close();
  });
});

test("with reduced motion the story is words only and loads no Rive", async () => {
  const { context, page } = await visit("desktop", "/", true);
  const rive: string[] = [];
  page.on("request", (r) => r.url().includes("/rive/") && rive.push(r.url()));
  await page.locator("canvas").scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("heading", { name: "Every cart is checked before it pays." }).waitFor();
  await page.waitForTimeout(500);
  expect(rive).toEqual([]);
  expect(await page.locator("canvas").getAttribute("data-ready")).not.toBe("true");
  await context.close();
});

test("keyboard focus is visible", async () => {
  const { context, page } = await visit("desktop");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const outline = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    return getComputedStyle(el).outlineStyle;
  });
  expect(outline).not.toBe("none");
  await context.close();
});

test("a signed-out visitor who opens the mandate form is sent to the welcome", async () => {
  const { context, page } = await visit("desktop", "/new/");
  await page.waitForURL(`${base}/`);
  await context.close();
});

test("the welcome stays inside its budgets", async () => {
  const html = await readFile(join(out, "index.html"), "utf8");
  const assets = [...new Set(html.match(/\/_next\/static\/[^"]+\.(js|css)/g) ?? [])];
  const gz = async (ext: string) => {
    let total = 0;
    for (const a of assets.filter((x) => x.endsWith(ext))) {
      total += gzipSync(await readFile(join(out, a))).length;
    }
    return total;
  };
  const js = await gz(".js");
  const css = await gz(".css");
  const riv = (await stat(join(out, "rive/onboarding.riv"))).size;

  const { context, page } = await visit("mobile");
  const lcp = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        new PerformanceObserver((list) => {
          const last = list.getEntries().at(-1);
          resolve(last ? last.startTime : 0);
        }).observe({ type: "largest-contentful-paint", buffered: true });
      }),
  );
  await context.close();
  console.info(
    JSON.stringify({
      firstLoadJsGzip: js,
      cssGzip: css,
      onboardingRiv: riv,
      lcpMsLocal: Math.round(lcp),
    }),
  );
  expect(js).toBeLessThan(230_000);
  expect(css).toBeLessThan(15_000);
  expect(riv).toBeLessThan(16_000);
  expect(lcp).toBeLessThan(1_800);
});

test("render.yaml serves the app's Content-Security-Policy", async () => {
  const blueprint = parse(
    await readFile(new URL("../../../../render.yaml", import.meta.url), "utf8"),
  ) as {
    services: { name: string; headers?: { path: string; name: string; value: string }[] }[];
  };
  const web = blueprint.services.find((s) => s.name === "keelson-web");
  expect(web?.headers?.find((h) => h.name === "Content-Security-Policy")?.value).toBe(CSP);
});

test("the CSP holds: no violation while the story plays", async () => {
  const { context, page } = await visit("desktop");
  const violations: string[] = [];
  page.on(
    "console",
    (m) => m.text().includes("Content Security Policy") && violations.push(m.text()),
  );
  await page.locator("canvas[data-ready=true]").waitFor({ timeout: 15_000 });
  expect(violations).toEqual([]);
  await context.close();
});

test("the first paint is the welcome, before any script or session read", async () => {
  const html = await readFile(join(out, "index.html"), "utf8");
  expect(html).toContain("someone answers, and it isn");
  expect(html).not.toContain("Loading…");
});

const VISITOR_VIEWS = [
  ["merchant/", "Merchant console", "Checking your session"],
  ["operator/", "Operator console", "Checking your session"],
  ["judge/", "Judge Keelson in five minutes", "Opening Judge Mode"],
] as const;

test.each(VISITOR_VIEWS)(
  "the first paint of /%s is what a visitor sees",
  async (path, h1, wait) => {
    const html = await readFile(join(out, path, "index.html"), "utf8");
    expect(html).toContain(h1);
    expect(html).not.toContain(wait);
  },
);

test.each(VISITOR_VIEWS)(
  "a visitor on /%s calls no signed-in route and logs no error",
  async (path, h1) => {
    const context = await browser.newContext();
    const calls: string[] = [];
    await context.route("https://api.keelson.finance/**", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/auth/get-session") {
        return route.fulfill({ status: 200, contentType: "application/json", body: "null" });
      }
      calls.push(url.pathname);
      return route.abort("connectionrefused");
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/${path}`);
    await page.getByRole("heading", { level: 1, name: h1 }).waitFor();
    await page.waitForLoadState("networkidle");
    expect(calls.filter((p) => p.startsWith("/v1/"))).toEqual([]);
    expect(errors).toEqual([]);
    await context.close();
  },
);

test("a missing page says so on the brand, in light and dark", async () => {
  const html = await readFile(join(out, "404.html"), "utf8");
  expect(html).not.toContain("next-error-h1");
  for (const colorScheme of ["light", "dark"] as const) {
    const context = await browser.newContext({ colorScheme });
    await context.route("https://api.keelson.finance/**", (route) =>
      route.abort("connectionrefused"),
    );
    const page = await context.newPage();
    await page.goto(`${base}/404.html`);
    await page.getByRole("heading", { level: 1, name: "This page does not exist" }).waitFor();
    expect(await page.getByRole("link", { name: "Go to the app" }).getAttribute("href")).toBe("/");
    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
      .analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    await context.close();
  }
});

test("mobile pages never scroll sideways", async () => {
  const { context, page } = await visit("mobile");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await context.close();
});

const rate = (method: string, k: number, n: number, lo: number, hi: number) => ({
  method,
  k,
  n,
  ppm: n === 0 ? null : Math.round((k * 1e6) / n),
  lo_ppm: lo,
  hi_ppm: hi,
});

/** A scoreboard in the API's shape: two backbones and the pooled rows. */
function board(id: string, attacks: number, complete: boolean) {
  const rows = ["vulnerable", "guarded", "all"].flatMap((backbone) =>
    (["seen", "holdout", "all"] as const).map((split) => ({
      backbone,
      split,
      models: backbone === "all" ? [] : [`model-${backbone}`],
      attacks,
      proposed: attacks - 1,
      asr: rate("wilson", 1, attacks - 1, 10_000, 400_000),
      escape: rate("clopper-pearson", 0, 237, 0, 15_446),
      false_blocks: rate("wilson", 0, 640, 0, 5_964),
      utility: rate("wilson", 2, attacks, 50_000, 600_000),
      amber: { k: 1, n: attacks - 1, ppm: 100_000 },
      usd_micros: 1_000_000,
    })),
  );
  return {
    v: "keelson.scoreboard/1",
    campaign: id,
    started: "2026-11-10T12:00:00.000Z",
    commit: "76c8620abcdef",
    lines: attacks + 2,
    head: "ab".repeat(32),
    complete,
    attacks,
    mutator_usd_micros: complete ? 760_000 : null,
    rows,
  };
}

/** The scoreboard against the API's public red-team routes, answered from this test. */
async function scoreboardVisit(kind: keyof typeof VIEWPORTS, live: boolean) {
  const id = "01M72AN4VSH4FYYT9X7RF01P3N";
  const context = await browser.newContext(VIEWPORTS[kind]);
  await context.route("https://api.keelson.finance/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) =>
      route.fulfill({ json: body, headers: { "access-control-allow-origin": "*" } });
    if (path === "/v1/redteam/campaigns") {
      return json({
        campaigns: [
          { id, startedAt: "2026-11-10T12:00:00.000Z", finishedAt: null, attacks: 10 },
          {
            id: "01M72AKHZ75KJSNS17AA9BJTJY",
            startedAt: "2026-11-10T11:00:00.000Z",
            finishedAt: "2026-11-10T11:10:00.000Z",
            attacks: 22,
          },
        ],
      });
    }
    if (path.endsWith("/scoreboard")) return json(board(id, 10, !live));
    if (path.endsWith("/scoreboard/stream")) {
      return route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
        body: `event: scoreboard\ndata: ${JSON.stringify(board(id, 1008, true))}\n\nevent: end\ndata: \n\n`,
      });
    }
    return route.abort("connectionrefused");
  });
  const page = await context.newPage();
  await page.goto(`${base}/scoreboard/`);
  await page.getByRole("heading", { level: 1 }).waitFor();
  return { context, page };
}

describe.each(Object.keys(VIEWPORTS) as (keyof typeof VIEWPORTS)[])("scoreboard on %s", (kind) => {
  test("shows the published numbers, the ledger and no accessibility violations", async () => {
    const { context, page } = await scoreboardVisit(kind, false);
    await page.getByText("0 of 237").first().waitFor();
    expect(await page.getByRole("link", { name: "Download ledger" }).getAttribute("href")).toBe(
      "https://api.keelson.finance/v1/redteam/campaigns/01M72AN4VSH4FYYT9X7RF01P3N/ledger",
    );
    expect(await page.getByText("≤ 1.55% at 95% · Clopper-Pearson").count()).toBeGreaterThan(0);
    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
      .analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    // On a phone the layout viewport grows to fit wide content, so compare with the screen.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= screen.width)).toBe(
      true,
    );
    await context.close();
  });
});

test("a running campaign's scoreboard follows the stream until it ends", async () => {
  const { context, page } = await scoreboardVisit("desktop", true);
  await page.getByText("Finished").waitFor();
  await page.getByText("1,008 attacks").first().waitFor();
  await context.close();
});

test("the methodology states every denominator and how to recompute", async () => {
  const { context, page } = await visit("desktop", "/scoreboard/methodology/");
  await expect(page.getByRole("heading", { level: 1 }).textContent()).resolves.toBe(
    "How the red-team scoreboard is measured",
  );
  for (const metric of ["Agent ASR", "Escape rate", "False blocks", "Utility under attack"]) {
    expect(await page.getByText(metric, { exact: true }).count()).toBe(1);
  }
  expect(
    await page.getByText("services/redteam/scripts/scoreboard.ts", { exact: false }).count(),
  ).toBe(1);
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  await context.close();
});

test("a blocked cart shows, field by field, what the mandate allowed against the cart", async () => {
  const context = await browser.newContext();
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 86_400_000).toISOString();
  const [mandateId, purchaseId] = ["01M7MANDATE000000000000000", "01M7PURCHASE00000000000000"];
  await context.route("https://api.keelson.finance/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (value: unknown) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/api/auth/get-session") {
      return json({
        session: {
          id: "s",
          userId: "u",
          token: "t",
          expiresAt: later,
          createdAt: now,
          updatedAt: now,
        },
        user: {
          id: "u",
          name: "Buyer",
          email: "b@example.test",
          emailVerified: false,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
    if (path === `/v1/mandates/${mandateId}`) {
      return json({
        id: mandateId,
        state: "ACTIVE",
        mandateHash: null,
        budget: { currency: "USD", maxMinor: "10000", remainingMinor: "10000" },
        expiresAt: later,
        hold: null,
        card: {
          rows: [
            {
              field: "total",
              label: "Total",
              values: ["≤ $100.00"],
              color: "green",
              answers: "Keelson",
            },
            {
              field: "items",
              label: "Items",
              values: ["Running shoes"],
              color: "green",
              answers: "Keelson",
            },
          ],
          warnings: [],
        },
        purchases: [
          {
            id: purchaseId,
            merchantId: "runfast",
            amount: { currency: "USD", minor: "34000" },
            createdAt: now,
            state: "DENIED",
            mode: "2of2",
            blocked: ["total", "items"],
            disputes: [],
          },
        ],
        pendingHolds: [],
      });
    }
    return route.abort("connectionrefused");
  });
  const page = await context.newPage();
  await page.goto(`${base}/purchase/?mandate=${mandateId}&id=${purchaseId}`);
  await page.getByText("blocked the cart before payment").waitFor();
  const lines = page.locator('[data-slot="block-diff"]');
  expect(await lines.count()).toBe(2);
  expect(await lines.nth(0).innerText()).toMatch(/Mandate ≤ \$100\.00[\s\S]*Cart \$340\.00/);
  expect(await lines.nth(1).innerText()).toMatch(/Mandate Running shoes[\s\S]*Cart not as signed/);
  await context.close();
});

test("a captured purchase shows its anonymous proof, read from the live API", async () => {
  const context = await browser.newContext();
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 86_400_000).toISOString();
  // A sandbox purchase whose C1 and C3 proofs were composed; the session and mandate are local.
  const [mandateId, purchaseId] = ["01M7MANDATE000000000000000", "01M73AGWP5EJSW35XE6Q090MCH"];
  await context.route("https://api.keelson.finance/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (value: unknown) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
    if (path.startsWith("/v1/anonymous-purchases/") || path.startsWith("/v1/user-set/roots/")) {
      const live = await route.fetch();
      return route.fulfill({
        status: live.status(),
        contentType: "application/json",
        body: await live.text(),
      });
    }
    if (path === "/api/auth/get-session") {
      return json({
        session: {
          id: "s",
          userId: "u",
          token: "t",
          expiresAt: later,
          createdAt: now,
          updatedAt: now,
        },
        user: {
          id: "u",
          name: "Buyer",
          email: "b@example.test",
          emailVerified: false,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
    if (path === `/v1/mandates/${mandateId}`) {
      return json({
        id: mandateId,
        state: "ACTIVE",
        mandateHash: null,
        budget: { currency: "USD", maxMinor: "10000", remainingMinor: "9900" },
        expiresAt: later,
        hold: null,
        card: { rows: [], warnings: [] },
        purchases: [
          {
            id: purchaseId,
            merchantId: "runfast",
            amount: { currency: "USD", minor: "100" },
            createdAt: "2026-11-10T18:11:32Z",
            state: "CAPTURED",
            mode: "2of2",
            logIndex: "783",
            disputes: [],
          },
        ],
        pendingHolds: [],
      });
    }
    return route.abort("connectionrefused");
  });
  const page = await context.newPage();
  await page.goto(`${base}/purchase/?mandate=${mandateId}&id=${purchaseId}`);
  await page.locator("[data-anonymous-proof=proven]").waitFor();
  await page.getByText("you are one of 125 users").waitFor();
  expect(
    await page.getByRole("link", { name: "Verify the anonymous proof" }).getAttribute("href"),
  ).toBe(`https://verify.keelson.finance/a/${purchaseId}?proof=anonymous`);
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  await context.close();
});
