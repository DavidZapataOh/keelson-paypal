import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const out = fileURLToPath(new URL("../../out", import.meta.url));
const API = "https://api.keelson.finance";
const APP = "https://app.keelson.finance";
const HOST = "https://agents.example.com";
const EVIL = "https://evil.example.net";
const REF = "01M7EMBEDREF00000000000000";
const URL_ = `${API}/embed/approve?r=${REF}#t=ket_${"a".repeat(43)}`;
const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
};

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const REASON =
  "I am the shopping agent on this demo platform. You asked me to find and buy running shoes under $120 at RunFast; I compare the pairs, then check out only what you approve here.";

const view = (state = "PENDING", mandateId: string | null = null) => ({
  ref: REF,
  origin: HOST,
  request: {
    code: "BCDF-GHJK",
    kind: "connect",
    state,
    name: "Shopping agent",
    reason: REASON,
    agent: {
      agentId: "4242",
      operator: "Errand Labs",
      bond: { asset: "PYUSD", min: 50_000_000, vault: "0x1" },
    },
    limits: {
      currency: "USD",
      perPurchaseMinor: "6000",
      totalMinor: "12000",
      askAboveMinor: "4000",
      merchants: [{ id: "mrc_runfast", name: "RunFast" }],
      until: later(7 * 86_400_000),
    },
    parent: null,
    mandateId,
    expiresAt: later(14 * 60_000),
  },
});

async function asset(path: string): Promise<string | undefined> {
  for (const candidate of [join(out, path), join(out, path, "index.html")]) {
    if ((await stat(candidate).catch(() => undefined))?.isFile()) return candidate;
  }
  return undefined;
}

interface Api {
  state: string;
  mandateId: string | null;
  opened: number;
  declined: number;
}

/**
 * A browser where `HOST` (or `EVIL`) is an agent platform page with the SDK, Keelson's API serves
 * the exported embed page with `frame-ancestors` for `HOST` only, and the app serves the export.
 */
async function world(opts: { hostOrigin?: string; overlay?: boolean; ancestors?: string } = {}) {
  const api: Api = { state: "PENDING", mandateId: null, opened: 0, declined: 0 };
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const hostOrigin = opts.hostOrigin ?? HOST;
  const hostPage = `<!doctype html><html lang="en"><head><title>Host</title>
<script src="${APP}/embed/v1.js"></script></head><body style="margin:0;padding:24px;font-family:sans-serif">
<main><h1>Agent platform</h1><div id="slot" style="width:440px;position:relative"></div>
${opts.overlay ? '<div style="position:fixed;inset:0;background:rgb(255 255 255/.01)"></div>' : ""}
<iframe id="evil" title="Other" src="${EVIL}/forge"></iframe></main>
<script>
window.events = [];
window.mounted = Keelson.mount(document.getElementById("slot"), { url: ${JSON.stringify(URL_)}, onEvent: (e) => window.events.push(e) });
</script></body></html>`;
  const forge = `<!doctype html><html lang="en"><head><title>Forge</title></head><body><script>
setInterval(() => parent.postMessage({ source: "keelson", version: 1, type: "approved", requestId: "x", mandateId: "forged" }, "*"), 200);
</script></body></html>`;
  await context.route(`${hostOrigin}/`, (r) =>
    r.fulfill({ contentType: "text/html", body: hostPage }),
  );
  await context.route(`${EVIL}/forge`, (r) => r.fulfill({ contentType: "text/html", body: forge }));
  const serve = async (r: Parameters<Parameters<BrowserContext["route"]>[1]>[0], path: string) => {
    const file = await asset(decodeURIComponent(path));
    if (!file) return r.fulfill({ status: 404 });
    return r.fulfill({
      contentType: TYPES[extname(file)] ?? "application/octet-stream",
      body: await readFile(file),
      headers: { "access-control-allow-origin": "*" },
    });
  };
  await context.route(`${APP}/**`, (r) => serve(r, new URL(r.request().url()).pathname));
  await context.route(`${API}/**`, async (r) => {
    const req = r.request();
    const url = new URL(req.url());
    if (url.pathname === "/embed/approve") {
      const file = (await asset("/embed/approve")) as string;
      return r.fulfill({
        contentType: "text/html",
        body: await readFile(file),
        headers: {
          "content-security-policy": `frame-ancestors ${opts.ancestors ?? HOST}`,
          "permissions-policy": "publickey-credentials-get=(), payment=()",
        },
      });
    }
    if (url.pathname.startsWith("/_next/")) return serve(r, url.pathname);
    if (!url.pathname.startsWith("/v1/")) return r.fulfill({ status: 404 });
    // The frame never sends cookies.
    expect(await req.headerValue("cookie")).toBeNull();
    if (url.pathname === "/v1/embed/sessions") {
      api.opened += 1;
      if (api.opened > 1) {
        return r.fulfill({ status: 401, contentType: "application/problem+json", body: "{}" });
      }
      return r.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ session: `kes_${"b".repeat(43)}`, embed: view() }),
      });
    }
    if ((await req.headerValue("keelson-embed")) !== `kes_${"b".repeat(43)}`) {
      return r.fulfill({ status: 401, contentType: "application/problem+json", body: "{}" });
    }
    if (url.pathname === "/v1/embed/request") {
      return r.fulfill({
        contentType: "application/json",
        body: JSON.stringify(view(api.state, api.mandateId)),
      });
    }
    if (url.pathname === "/v1/embed/deny") {
      api.declined += 1;
      api.state = "DENIED";
      return r.fulfill({ contentType: "application/json", body: JSON.stringify(view("DENIED")) });
    }
    return r.abort("connectionrefused");
  });
  const page = await context.newPage();
  await page.goto(`${hostOrigin}/`);
  return { context, page, api };
}

const frameOf = (page: Page) => page.frameLocator("#slot iframe");
/** Waits until the SDK has sized the frame to its whole content, so nothing inside it scrolls. */
const settled = (page: Page) =>
  expect
    .poll(() =>
      page
        .frameLocator("#slot iframe")
        .locator("html")
        .evaluate((el) => el.scrollHeight - innerHeight),
    )
    .toBe(0);
const events = (page: Page) =>
  page.evaluate(() => (window as unknown as { events: { type: string }[] }).events);
const typesOf = async (page: Page) => (await events(page)).map((e) => e.type);

async function shot(page: Page, name: string) {
  const dir = process.env.KEELSON_SHOTS;
  if (dir) await page.screenshot({ path: join(dir, `embed-${name}.png`), fullPage: true });
}

describe("the embedded approval", () => {
  test("opens with the token once, tells its host ready and its height, and ignores forgeries", async () => {
    const { context, page, api } = await world();
    const frame = frameOf(page);
    await frame
      .getByRole("heading", { name: /Shopping agent wants to spend up to \$120\.00/ })
      .waitFor();
    await expect.poll(() => typesOf(page)).toContain("ready");
    await expect.poll(() => typesOf(page)).toContain("resize");
    // The SDK sized the frame to its content: no inner scrollbar.
    await settled(page);
    // The other frame's forged "approved" never reaches the host.
    await page.waitForTimeout(800);
    expect(await typesOf(page)).not.toContain("approved");
    expect(api.opened).toBe(1);
    await frame.getByText("on agents.example.com").waitFor();
    await frame.getByText("Errand Labs", { exact: true }).waitFor();
    await frame.getByText(/Who answers/).waitFor();
    await shot(page, "review");
    const { violations } = await new AxeBuilder({ page })
      .include("#slot")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(violations.map((v) => v.id)).toEqual([]);
    await context.close();
  });

  test("Allow waits until it has been visible, then opens Keelson's own window with the lowered limits", async () => {
    const { context, page, api } = await world();
    const frame = frameOf(page);
    const allow = frame.getByRole("button", { name: "Allow $120.00" });
    await allow.waitFor();
    expect(await allow.getAttribute("aria-disabled")).toBe("true");
    await frame.getByLabel("Most in total").fill("9000");
    // It arms only once the user can see it.
    await frame.getByRole("button", { name: "Allow $90.00" }).scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    await frame.getByRole("button", { name: "Allow $90.00" }).waitFor();
    await expect
      .poll(() => frame.getByRole("button", { name: "Allow $90.00" }).getAttribute("aria-disabled"))
      .toBe("false");
    const popupWaiter = context.waitForEvent("page");
    await frame.getByRole("button", { name: "Allow $90.00" }).click();
    const popup = await popupWaiter;
    const signing = new URL(popup.url());
    expect(signing.origin).toBe(APP);
    expect(signing.pathname).toBe("/connect/");
    expect(Object.fromEntries(signing.searchParams)).toMatchObject({
      c: "BCDF-GHJK",
      embed: REF,
      via: "frame",
      tt: "9000",
      pp: "6000",
    });
    await frame.getByText("Confirm in the Keelson window").waitFor();
    await shot(page, "waiting");
    // The user signs there; the frame reads the answer from Keelson, not from any message.
    api.state = "APPROVED";
    api.mandateId = "01M7MANDATE000000000000000";
    await frame.getByRole("heading", { name: "Approved" }).waitFor({ timeout: 6_000 });
    await expect
      .poll(() => events(page))
      .toContainEqual({
        source: "keelson",
        version: 1,
        type: "approved",
        requestId: REF,
        mandateId: "01M7MANDATE000000000000000",
      });
    await shot(page, "approved");
    await context.close();
  });

  test("a covered frame never arms its Allow button", async () => {
    const { context, page } = await world({ overlay: true });
    const allow = frameOf(page).getByRole("button", { name: "Allow $120.00" });
    await allow.waitFor();
    // Intersection Observer v2 sees the cover; this browser must support it for the test to mean anything.
    expect(await allow.evaluate(() => "isVisible" in IntersectionObserverEntry.prototype)).toBe(
      true,
    );
    await settled(page);
    await allow.scrollIntoViewIfNeeded();
    await page.waitForTimeout(2_000);
    expect(await allow.getAttribute("aria-disabled")).toBe("true");
    await context.close();
  });

  test("declining tells the host, and nothing is signed", async () => {
    const { context, page, api } = await world();
    const frame = frameOf(page);
    await settled(page);
    const reject = frame.getByRole("button", { name: "Reject" });
    await reject.scrollIntoViewIfNeeded();
    // Chromium drops clicks on a cross-origin frame that has just moved.
    await page.waitForTimeout(600);
    await reject.click();
    await frame.getByRole("heading", { name: "Declined" }).waitFor();
    expect(api.declined).toBe(1);
    await expect.poll(() => typesOf(page)).toContain("declined");
    await shot(page, "declined");
    await context.close();
  });

  test("framed by a page other than the platform's, it shows nothing", async () => {
    // `frame-ancestors` normally stops this; the page checks its ancestor too.
    const { context, page } = await world({ hostOrigin: EVIL, ancestors: "*" });
    const frame = frameOf(page);
    await frame.getByRole("heading", { name: "Open this from the agent's app" }).waitFor();
    expect(await frame.getByRole("button", { name: /Allow/ }).count()).toBe(0);
    expect(await typesOf(page)).not.toContain("ready");
    await context.close();
  });
});
