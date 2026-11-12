import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { REPO } from "./lib/markdown";

const tour = readFileSync(join(REPO, "apps/web/components/judge/tour.tsx"), "utf8");
const steps = [...tour.matchAll(/title: "([^"]+)",\s*role: "(\w+)",\s*line: "([^"]+)"/g)].map(
  (m) => ({ title: m[1], role: m[2] }),
);
const page = readFileSync(
  join(REPO, "apps/docs/src/content/docs/quickstart/judge-mode.mdoc"),
  "utf8",
);
const h3 = [...page.matchAll(/^### \d+\. (.+)$/gm)].map((m) => m[1]);

describe("the Judge Mode walkthrough", () => {
  test("follows the product's own steps, in order", () => {
    expect(steps.length).toBeGreaterThanOrEqual(9);
    expect(h3).toEqual(steps.map((s) => s.title));
  });

  test("says what you should see at every step", () => {
    expect(page.match(/^What you should see:/gm)?.length).toBe(steps.length);
  });
});
