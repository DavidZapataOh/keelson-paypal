import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { extractChecks } from "./lib/checks";
import { extractMermaid, REPO } from "./lib/markdown";

const file = join(REPO, "apps/docs/src/content/docs/security/environments.mdoc");
const page = readFileSync(file, "utf8");
const rows = page.split("\n").filter((l) => l.startsWith("|") && !/^\|\s*-/.test(l));
const cells = (row: string) =>
  row
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim());

describe("real or sandbox", () => {
  test("has one row per dependency, each with a way to check it", () => {
    const [head, ...body] = rows;
    expect(cells(head ?? "")).toEqual(["Dependency", "Environment", "What that means", "Check"]);
    expect(body.length).toBeGreaterThanOrEqual(12);
    const ids = new Set(extractChecks(page, file).map((c) => c.id));
    for (const r of body) {
      const check = cells(r)[3] ?? "";
      const anchor = check.match(
        /\]\((#[a-z0-9-]+|\/security\/verify\/#[a-z0-9-]+|https:\/\/[^)]+)\)/,
      )?.[1];
      expect(anchor, cells(r)[0]).toBeDefined();
      if (anchor?.startsWith("#"))
        expect(ids.has(anchor.slice(1)) || page.includes(`{% #${anchor.slice(1)} %}`), anchor).toBe(
          true,
        );
    }
  });

  test("checks the PayPal environment and the live purchases on production", () => {
    const ids = extractChecks(page, file).map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["env-paypal-sandbox", "env-live-purchases"]));
  });
});

describe("how it works", () => {
  test("draws the system, a purchase, a dispute and a card mandate", () => {
    const howFile = join(REPO, "apps/docs/src/content/docs/concepts/how-it-works.mdoc");
    expect(extractMermaid(readFileSync(howFile, "utf8")).length).toBeGreaterThanOrEqual(4);
  });
});
