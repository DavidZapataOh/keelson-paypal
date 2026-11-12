import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { REPO } from "./lib/markdown";

const page = readFileSync(
  join(REPO, "apps/docs/src/content/docs/quickstart/verify-an-alibi.mdoc"),
  "utf8",
);
const labels = readFileSync(join(REPO, "apps/verify/src/labels.ts"), "utf8");
const checks = [
  ...labels.matchAll(/^\s+"?([a-z0-9_.]+)"?: \{\s*label: "([^"]+)",\s*who: "([^"]+)"/gm),
].map((m) => ({
  id: m[1] as string,
  label: m[2] as string,
  who: m[3] as string,
}));

describe("the quickstart's table of checks", () => {
  test("reads the verifier's own check list", () => {
    expect(checks.length).toBeGreaterThanOrEqual(25);
  });

  test("has one row per check the verifier runs, with the verifier's label and who answers for it", () => {
    for (const c of checks) {
      const row = page.split("\n").find((l) => l.startsWith(`| \`${c.id}\` |`));
      expect(row, c.id).toBeDefined();
      expect(row).toContain(c.label);
      expect(row).toContain(c.who);
    }
  });
});
