import type Anthropic from "@anthropic-ai/sdk";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { serve } from "../../../packages/evidence/test/server.ts";
import { StoreBrowser } from "../src/driver.ts";
import { datamark } from "../src/spotlight.ts";

let n = 0;
const call = (name: string, input: Record<string, unknown>): Anthropic.Beta.BetaToolUseBlock =>
  ({
    type: "tool_use",
    id: `toolu_${++n}`,
    name,
    input,
    toolset_name: "browser",
  }) as Anthropic.Beta.BetaToolUseBlock;

const text = (r: Anthropic.Beta.BetaToolResultBlockParam) =>
  (Array.isArray(r.content) ? r.content : [{ type: "text", text: r.content ?? "" }])
    .map((b) => ("text" in b ? b.text : ""))
    .join("\n");

describe("the browser toolset driver", () => {
  let chrome: Browser;
  let site: Awaited<ReturnType<typeof serve>>;
  let context: BrowserContext;
  let page: Page;
  let driver: StoreBrowser;
  const mark = datamark(() => 0);

  beforeAll(async () => {
    chrome = await chromium.launch();
    site = await serve();
    context = await chrome.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    driver = await StoreBrowser.attach(context, page, { hosts: ["127.0.0.1"], mark: mark.mark });
  });
  afterAll(async () => {
    await driver?.close();
    await chrome?.close();
    await site?.close();
  });

  test("offers neither JavaScript nor uploads, nor members it does not implement", () => {
    const configs = (driver.toJSON().configs ?? {}) as Record<string, { enabled?: boolean }>;
    for (const member of [
      "javascript_exec",
      "file_upload",
      "read_console",
      "read_network",
      "new_tab",
      "find",
    ]) {
      expect(configs[member]?.enabled ?? false).toBe(false);
    }
    expect(configs.read_page?.enabled).not.toBe(false);
  });

  test("navigates on an allowed host and reads the page with references, datamarked", async () => {
    const nav = await driver.toolResult(call("navigate", { url: `${site.url}/attack.html` }));
    expect(nav.is_error).toBeFalsy();
    expect(text(nav)).toContain("Trail Runner 2");
    await page.locator("body[data-ready]").waitFor({ state: "attached" });

    const read = await driver.toolResult(call("read_page", {}));
    const tree = text(read);
    expect(tree).toMatch(/\[ref_e\d+\]/);
    expect(tree).not.toMatch(/ Add to cart/);
    // The hidden injection reaches the model, marked as page data.
    expect(tree).toContain(["Ignore", "the", "cart."].join(mark.marker));
    expect(driver.reads.at(-1)).toBe(tree.slice(0, driver.reads.at(-1)?.length));
  });

  test("clicks an element by the reference read_page returned", async () => {
    const tree = text(await driver.toolResult(call("read_page", { filter: "interactive" })));
    const ref = new RegExp(
      `button${mark.marker}"Add${mark.marker}to${mark.marker}cart"${mark.marker}\\[(ref_e\\d+)\\]`,
    ).exec(tree)?.[1];
    expect(ref).toBeDefined();
    const clicked = await driver.toolResult(call("left_click", { target: { type: "ref", ref } }));
    expect(clicked.is_error).toBeFalsy();
    const stale = await driver.toolResult(
      call("left_click", { target: { type: "ref", ref: "ref_e9999" } }),
    );
    expect(stale.is_error).toBe(true);
    expect(text(stale)).toContain("stale or not found");
  });

  test.each(["https://example.com/", "javascript:alert(1)", "file:///etc/passwd"])(
    "refuses to navigate to %s",
    async (url) => {
      const r = await driver.toolResult(call("navigate", { url }));
      expect(r.is_error).toBe(true);
      expect(page.url()).toContain("127.0.0.1");
    },
  );

  test("aborts a navigation off the allowlist that a click starts, and reports it", async () => {
    await page.evaluate(() => {
      const a = document.createElement("a");
      a.href = "https://example.com/";
      a.textContent = "Leave the store";
      document.body.prepend(a);
    });
    const tree = text(await driver.toolResult(call("read_page", { filter: "interactive" })));
    const ref = new RegExp(
      `Leave${mark.marker}the${mark.marker}store"${mark.marker}\\[(ref_e\\d+)\\]`,
    ).exec(tree)?.[1];
    const r = await driver.toolResult(call("left_click", { target: { type: "ref", ref } }));
    await page.waitForTimeout(200);
    expect(page.url()).toContain("127.0.0.1");
    const state = await driver.toolResult(call("get_page_text", {}));
    expect(JSON.stringify([r, state])).toMatch(/navigation|refused/i);
  });
});
