import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { describe, expect, test } from "vitest";
import { docFiles, REPO } from "./lib/markdown";

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
