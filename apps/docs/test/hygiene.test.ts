import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { docFiles, extractLinks, REPO } from "./lib/markdown";

const OWN = /^https:\/\/github\.com\/DavidZapataOh\/keelson-paypal\/(?:blob|tree)\/main\/([^#?]+)/;
const BANNED = /\b(TODO|TBD|FIXME)\b|illustrative|lorem ipsum|coming soon/;

describe("documentation hygiene", () => {
  for (const file of docFiles()) {
    const name = relative(REPO, file);
    test(`${name} has no placeholder text`, () => {
      const hits = readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, i) =>
          BANNED.test(line) ? [`${name}:${i + 1}: ${line.match(BANNED)?.[0]}`] : [],
        );
      expect(hits).toEqual([]);
    });
  }
});

// Links into this repository's main branch are checked against the working tree, so a page
// may link a file in the same change that adds it.
describe("links into the repository", () => {
  for (const file of docFiles()) {
    const name = relative(REPO, file);
    test(`${name} links only paths that exist`, () => {
      const missing = extractLinks(readFileSync(file, "utf8"))
        .map((link) => OWN.exec(link)?.[1])
        .filter((path): path is string => path !== undefined && !existsSync(join(REPO, path)));
      expect(missing).toEqual([]);
    });
  }
});

// The section names are the top bar's link texts; Lighthouse's link-text audit fails on generic
// ones such as "Start" or "More".
test("every section name says where its link goes", () => {
  const config = readFileSync(join(REPO, "apps/docs/src/content.config.ts"), "utf8");
  const SECTIONS = [
    ...(/SECTIONS = \[([^\]]+)\]/.exec(config)?.[1] ?? "").matchAll(/"([^"]+)"/g),
  ].map((m) => m[1] as string);
  expect(SECTIONS.length).toBeGreaterThan(0);
  const generic = ["start", "here", "more", "click here", "go", "read more", "learn more", "next"];
  expect(SECTIONS.filter((s) => generic.includes(s.toLowerCase()))).toEqual([]);
});
