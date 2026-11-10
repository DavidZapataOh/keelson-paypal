import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import AxeBuilder from "@axe-core/playwright";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { type Browser, chromium, type Page } from "playwright";
import { build, type PreviewServer, preview } from "vite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { brand, themes } from "../../src/tokens.ts";

const fixture = fileURLToPath(new URL("../fixture", import.meta.url));
const pkg = fileURLToPath(new URL("../..", import.meta.url));
const out = mkdtempSync(join(tmpdir(), "keelson-ui-"));
const plugins = [react(), tailwindcss()];

const BUDGET = { cssGzip: 20 * 1024, coreJsGzip: 20 * 1024, fullJsGzip: 80 * 1024 };

let server: PreviewServer;
let browser: Browser;
let base: string;

beforeAll(async () => {
  await build({
    root: fixture,
    logLevel: "silent",
    plugins,
    build: {
      outDir: join(out, "site"),
      emptyOutDir: true,
      rolldownOptions: {
        input: { index: join(fixture, "index.html"), studio: join(fixture, "studio.html") },
      },
    },
  });
  server = await preview({
    root: fixture,
    logLevel: "silent",
    build: { outDir: join(out, "site") },
    preview: { port: 0 },
  });
  base = server.resolvedUrls?.local[0] as string;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  rmSync(out, { recursive: true, force: true });
});

/** A fresh context per page: axe opens its own pages in the same context. */
async function open(path: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${base}${path}`);
  return page;
}

describe.each(["light", "dark"] as const)("the showcase in Chromium, %s", (theme) => {
  test("axe finds no WCAG 2.2 A/AA violation", async () => {
    const page = await open(`?theme=${theme}`);
    await page.getByRole("heading", { level: 1 }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
      .analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual(
      [],
    );
    await page.context().close();
  });

  test("the brand fonts load and the page uses the theme", async () => {
    const page = await open(`?theme=${theme}`);
    await page.getByRole("heading", { level: 1 }).waitFor();
    const r = await page.evaluate(async () => {
      await document.fonts.ready;
      const body = getComputedStyle(document.body);
      return {
        sans: document.fonts.check('16px "Instrument Sans Variable"'),
        mono: document.fonts.check('16px "Geist Mono Variable"'),
        family: body.fontFamily,
        bg: body.backgroundColor,
      };
    });
    expect(r.sans && r.mono).toBe(true);
    expect(r.family.startsWith('"Instrument Sans Variable"')).toBe(true);
    expect(r.bg).toBe(rgb(themes[theme].background));
    await page.context().close();
  });

  test("keyboard focus shows a ring in the ring color", async () => {
    const page = await open(`?theme=${theme}`);
    await page.getByRole("heading", { level: 1 }).waitFor();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Sign the mandate");
    // The ring transitions in; wait for it to settle on the ring color.
    await page.waitForFunction(
      (ring) => getComputedStyle(document.activeElement as Element).boxShadow.includes(ring),
      rgb(themes[theme].ring),
      { timeout: 2_000 },
    );
    await page.context().close();
  });
});

describe("keyboard and assistive technology", () => {
  test("a dialog traps focus, closes on Escape and returns focus to its trigger", async () => {
    const page = await open("");
    const trigger = page.getByRole("button", { name: "Revoke mandate" });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Revoke this mandate?" });
    await dialog.waitFor();
    await settled(page);
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }
    const { violations } = await new AxeBuilder({ page })
      .include('[role="dialog"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(violations.map((v) => v.id)).toEqual([]);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    expect(await trigger.evaluate((t) => t === document.activeElement)).toBe(true);
    await page.context().close();
  });

  test("a sheet opens from the right and closes on Escape", async () => {
    const page = await open("?theme=dark");
    await page.getByRole("button", { name: "Open purchase" }).click();
    const sheet = page.getByRole("dialog", { name: "Nike · $340.00" });
    await sheet.waitFor();
    await settled(page);
    const box = await sheet.boundingBox();
    expect(Math.round((box?.x ?? 0) + (box?.width ?? 0))).toBe(page.viewportSize()?.width);
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    await page.context().close();
  });

  test("tabs move with the arrow keys", async () => {
    const page = await open("");
    await page.getByRole("tab", { name: "All" }).click();
    // Radix moves focus on the next tick; each press waits for it.
    await page.keyboard.press("ArrowRight");
    await page.getByRole("tab", { name: "Blocked", selected: true }).waitFor();
    await page.keyboard.press("ArrowRight");
    await page.getByRole("tab", { name: "Loading", selected: true }).waitFor();
    await page.getByRole("tab", { name: "Disputed" }).click();
    await page.getByText("No disputes").waitFor();
    await page.context().close();
  });

  test("a select opens and picks with the keyboard", async () => {
    const page = await open("");
    const trigger = page.getByRole("combobox", { name: "Valid for" });
    await trigger.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("option", { name: "7 days" }).and(page.locator(":focus")).waitFor();
    await page.keyboard.press("ArrowDown");
    await page.getByRole("option", { name: "30 days" }).and(page.locator(":focus")).waitFor();
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => document.querySelector("#window")?.textContent === "30 days",
      undefined,
      { timeout: 2_000 },
    );
    await page.context().close();
  });

  test("a toast is announced in a live region", async () => {
    const page = await open("");
    await page.getByRole("button", { name: "Show a toast" }).click();
    const toast = page.locator("[data-sonner-toast]");
    await toast.waitFor();
    expect(await toast.textContent()).toContain("Mandate signed");
    expect(await page.locator("section[aria-live]").count()).toBeGreaterThan(0);
    await page.context().close();
  });

  test("an invalid field links its error and marks its label", async () => {
    const page = await open("");
    const input = page.getByRole("textbox", { name: "Maximum total" });
    expect(await input.getAttribute("aria-invalid")).toBe("true");
    const label = page.locator('label[for="max"]');
    const color = await label.evaluate((l) => getComputedStyle(l).color);
    expect(color).toBe(rgb(themes.light.destructive));
    await page.context().close();
  });

  test("reduced motion: nothing animates", async () => {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto(base);
    await page.getByRole("button", { name: "Revoke mandate" }).click();
    const durations = await page
      .getByRole("dialog")
      .evaluate((d) => [
        getComputedStyle(d).animationDuration,
        getComputedStyle(d).transitionDuration,
      ]);
    for (const d of durations) expect(Number.parseFloat(d)).toBeLessThanOrEqual(0.00001);
    await context.close();
  });
});

test("AG Studio resolves the brand theme in light and dark", async () => {
  const page = await open("studio.html");
  const read = () =>
    page.waitForFunction(() => {
      for (const el of document.querySelectorAll<HTMLElement>("#studio *")) {
        const s = getComputedStyle(el);
        const bg = s.getPropertyValue("--ag-background-color").trim();
        if (bg) {
          return {
            bg,
            fg: s.getPropertyValue("--ag-foreground-color").trim(),
            font: s.getPropertyValue("--ag-font-family").trim(),
          };
        }
      }
      return undefined;
    });
  const light = (await (await read()).jsonValue()) as { bg: string; fg: string; font: string };
  expect(light.bg.toLowerCase()).toBe(themes.light.background);
  expect(light.fg.toLowerCase()).toBe(themes.light.foreground);
  expect(light.font).toContain("Instrument Sans Variable");
  await page.evaluate(() => {
    document.body.dataset.agThemeMode = "dark";
  });
  await page.waitForFunction(
    (graphite) =>
      [...document.querySelectorAll<HTMLElement>("#studio *")].some(
        (el) =>
          getComputedStyle(el).getPropertyValue("--ag-background-color").trim().toLowerCase() ===
          graphite,
      ),
    brand.graphite,
  );
  await page.context().close();
});

test("bundle size within budget", async () => {
  // The components and their dependencies alone, with React external, as an app pays for them:
  // the core every app imports, and every component as the worst case.
  const gzip = async (entry: string) => {
    await build({
      root: pkg,
      logLevel: "silent",
      plugins,
      build: {
        outDir: join(out, entry),
        emptyOutDir: true,
        lib: { entry: join(fixture, `${entry}.ts`), formats: ["es"], fileName: "ui" },
        rolldownOptions: { external: [/^react($|\/)/, /^react-dom($|\/)/] },
      },
    });
    return gzipSync(readFileSync(join(out, entry, "ui.js"))).length;
  };
  const coreJsGzip = await gzip("size-core");
  const fullJsGzip = await gzip("size");
  const site = join(out, "site", "assets");
  const css = readdirSync(site).filter((f) => f.endsWith(".css"));
  const cssGzip = css.reduce((n, f) => n + gzipSync(readFileSync(join(site, f))).length, 0);
  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
  console.log(
    `ui css ${kb(cssGzip)} gzip, core js ${kb(coreJsGzip)} gzip, full js ${kb(fullJsGzip)} gzip`,
  );
  expect(css.length).toBe(1);
  expect(cssGzip).toBeLessThan(BUDGET.cssGzip);
  expect(coreJsGzip).toBeLessThan(BUDGET.coreJsGzip);
  expect(fullJsGzip).toBeLessThan(BUDGET.fullJsGzip);
});

/** Resolves once every finite CSS animation and transition has finished. */
async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (a) =>
          a.playState !== "running" ||
          a.effect?.getTiming().iterations === Number.POSITIVE_INFINITY,
      ),
  );
}

function rgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}
