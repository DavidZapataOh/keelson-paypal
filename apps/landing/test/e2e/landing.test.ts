import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { type Browser, type BrowserContext, chromium, devices, type Route } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { parse } from "yaml";

// Both sites are served from the builds turbo made, under their production origins and the headers
// render.yaml gives them, so the verifier's frame-ancestors and the API's CORS are the real ones.
const LANDING = "https://keelson.finance";
const VERIFY = "https://verify.keelson.finance";
const dist = (app: string) => fileURLToPath(new URL(`../../../${app}/dist`, import.meta.url));
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
  ".webmanifest": "application/manifest+json",
  ".mjs": "text/javascript",
};

interface Service {
  name: string;
  headers?: { path: string; name: string; value: string }[];
  routes?: { type: string; source: string; destination: string }[];
}
const blueprint = parse(
  await readFile(fileURLToPath(new URL("../../../../render.yaml", import.meta.url)), "utf8"),
) as { services: Service[] };
const service = (name: string) => blueprint.services.find((s) => s.name === name) as Service;

/** Serves a static site's build as Render does: its rewrites and its `/*` headers. */
function site(name: string, root: string) {
  const { headers = [], routes = [] } = service(name);
  return async (route: Route) => {
    let path = new URL(route.request().url()).pathname;
    for (const r of routes) {
      if (r.type === "rewrite" && path.startsWith(r.source.replace("*", ""))) path = r.destination;
    }
    if (path.endsWith("/")) path += "index.html";
    const file = join(root, decodeURIComponent(path));
    if (!(await stat(file).catch(() => undefined))?.isFile()) {
      await route.fulfill({ status: 404 });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        ...Object.fromEntries(headers.filter((h) => h.path === "/*").map((h) => [h.name, h.value])),
      },
      body: await readFile(file),
    });
  };
}

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

async function visit(kind: "desktop" | "mobile", reducedMotion = false): Promise<BrowserContext> {
  const context = await browser.newContext({
    ...(kind === "desktop" ? { viewport: { width: 1440, height: 900 } } : devices["Pixel 7"]),
    reducedMotion: reducedMotion ? "reduce" : "no-preference",
  });
  await context.route(`${LANDING}/**`, site("keelson-landing", dist("landing")));
  await context.route(`${VERIFY}/**`, site("keelson-verify", dist("verify")));
  return context;
}

describe("the landing", () => {
  test("a visitor tampers with a real Alibi and sees it fail in under 10 s from first load", async () => {
    const context = await visit("desktop");
    const page = await context.newPage();
    const start = performance.now();
    await page.goto(LANDING);
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: "Try to cheat" })
      .click();
    const frame = page.frameLocator('iframe[title^="Alibi verifier"]');
    await frame.getByText("Public receipt verified").waitFor({ timeout: 10_000 });
    await frame.getByRole("button", { name: "Fake the on-chain anchor" }).click();
    await frame.locator("[data-verdict=failed]").waitFor({ timeout: 10_000 });
    const elapsed = performance.now() - start;
    console.info(`tamper flow: ${elapsed.toFixed(0)} ms from first load`);
    expect(elapsed).toBeLessThan(10_000);
    expect(await frame.locator('[data-check="anchor.root"]').textContent()).toContain(
      "/anchor/anchored_root",
    );
    await context.close();
  });

  test.each(["desktop", "mobile"] as const)(
    "has no WCAG 2.2 A or AA violations (%s)",
    async (kind) => {
      // Reduced motion, so axe reads the end state rather than a reveal in flight.
      const context = await visit(kind, true);
      const page = await context.newPage();
      await page.goto(LANDING);
      await page.locator("#cheat").scrollIntoViewIfNeeded();
      await page
        .frameLocator('iframe[title^="Alibi verifier"]')
        .getByText("Public receipt verified")
        .waitFor({ timeout: 30_000 });
      const { violations } = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(" ")}`)).toEqual(
        [],
      );
      await context.close();
    },
  );

  test("every link resolves, and every anchor has a target", async () => {
    const context = await visit("desktop");
    const page = await context.newPage();
    await page.goto(LANDING);
    const hrefs = await page
      .locator("a[href]")
      .evaluateAll((els) =>
        els.map((e) => (e as HTMLAnchorElement).getAttribute("href") as string),
      );
    for (const href of new Set(hrefs.filter((h) => h.startsWith("#")))) {
      expect(await page.locator(href).count(), href).toBe(1);
    }
    const external = [...new Set(hrefs.filter((h) => h.startsWith("https://")))];
    expect(external.some((h) => h.includes("app.keelson.finance"))).toBe(true);
    for (const href of external) {
      const res = await fetch(href.split("#")[0] as string, { redirect: "follow" });
      expect(res.status, href).toBeLessThan(400);
    }
    await context.close();
  });

  test("claims only the checks the policy runs", async () => {
    const html = await readFile(join(dist("landing"), "index.html"), "utf8");
    // The policy's time check is when the cart is paid (`payment.execution_date`), not delivery.
    expect(html).not.toMatch(/Deliver by|quoted date/);
    expect(html).not.toMatch(/MCP server|@keelson\/sdk/);
  });
});
