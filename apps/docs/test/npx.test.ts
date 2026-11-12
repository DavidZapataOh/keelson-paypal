import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { docFiles, REPO } from "./lib/markdown";

/**
 * `npx <name>` runs the package called `<name>` from the registry wherever the reader's project
 * does not install it, so every command a page prints names the package that ships it: one of
 * this repository's published packages, or a third-party package by its own name.
 */
const THIRD_PARTY = new Set(["@modelcontextprotocol/inspector"]);

const published = new Set(
  readdirSync(join(REPO, "packages")).flatMap((dir) => {
    try {
      const pkg = JSON.parse(readFileSync(join(REPO, "packages", dir, "package.json"), "utf8"));
      return pkg.private ? [] : [pkg.name as string];
    } catch {
      return [];
    }
  }),
);

const pages = [
  ...docFiles(),
  ...readdirSync(join(REPO, "packages")).map((dir) => join(REPO, "packages", dir, "README.md")),
].filter((file) => {
  try {
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
});

describe("npx commands name the package that ships them", () => {
  for (const file of pages) {
    const name = relative(REPO, file);
    test(name, () => {
      const wrong = readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, i) =>
          [...line.matchAll(/\bnpx\s+(?:-y\s+|--yes\s+)?(@?[a-z0-9][\w./-]*)/g)]
            .map((m) => m[1] as string)
            .filter((pkg) => !published.has(pkg) && !THIRD_PARTY.has(pkg))
            .map((pkg) => `${name}:${i + 1}: npx ${pkg}`),
        );
      expect(wrong).toEqual([]);
    });
  }
});
