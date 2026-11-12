import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { docFiles, extractMermaid, REPO } from "./lib/markdown";

const mermaidJs = join(
  createRequire(import.meta.url).resolve("mermaid/package.json"),
  "../dist/mermaid.min.js",
);
const diagrams = docFiles().flatMap((file) =>
  extractMermaid(readFileSync(file, "utf8")).map((d) => ({ ...d, file: relative(REPO, file) })),
);
let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.setContent("<!doctype html><html><body></body></html>");
  await page.addScriptTag({ path: mermaidJs });
  await page.evaluate(() =>
    (window as unknown as { mermaid: { initialize(o: object): void } }).mermaid.initialize({
      startOnLoad: false,
    }),
  );
});
afterAll(async () => {
  await browser.close();
});

describe("diagrams", () => {
  test("the site has at least four", () => {
    expect(diagrams.filter((d) => d.file.startsWith("apps/docs/")).length).toBeGreaterThanOrEqual(
      4,
    );
  });

  for (const [i, d] of diagrams.entries()) {
    test(`${d.file}:${d.line} has a title and a description for screen readers`, () => {
      expect(d.code).toMatch(/^\s*accTitle:/m);
      expect(d.code).toMatch(/^\s*accDescr:/m);
    });
    test(`${d.file}:${d.line} renders`, async () => {
      const svg = await page.evaluate(
        async ([code, id]) =>
          (
            await (
              window as unknown as {
                mermaid: { render(id: string, c: string): Promise<{ svg: string }> };
              }
            ).mermaid.render(id, code)
          ).svg,
        [d.code, `d${i}`] as const,
      );
      expect(svg).toContain("<svg");
    });
  }
});
