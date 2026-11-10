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
