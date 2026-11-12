import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { REPO } from "./lib/markdown";

export const BCP14 =
  'The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all capitals, as shown here.';
const page = readFileSync(join(REPO, "apps/docs/src/content/docs/reference/spec.mdoc"), "utf8");
const sections = page.split(/^## /m).slice(1);

describe("the specification", () => {
  test("states BCP 14 verbatim and has one title", () => {
    expect(page).toContain(BCP14);
    expect(page.match(/^# /gm)).toBeNull();
  });

  test("every repository path it names exists", () => {
    const paths = [
      ...page.matchAll(/`((?:packages|engine|contracts|services|circuits|apps)\/[^`\s#]+)`/g),
    ].map((m) => m[1] as string);
    expect(paths.length).toBeGreaterThan(5);
    for (const p of paths) expect(existsSync(join(REPO, p)), p).toBe(true);
  });

  test("names only test vector files that exist", () => {
    for (const m of page.matchAll(/packages\/core\/test\/vectors\/([\w-]+\.json)/g)) {
      expect(existsSync(join(REPO, "packages/core/test/vectors", m[1] as string)), m[1]).toBe(true);
    }
  });

  test("the mandate, countersign, Alibi and PayPal sections state requirements", () => {
    for (const name of ["Mandate", "Countersign", "Alibi", "PayPal"]) {
      const s = sections.find((x) => new RegExp(`^\\d+\\. ${name}\\b`).test(x));
      expect(s, name).toBeDefined();
      expect(s, name).toMatch(/\bMUST\b/);
    }
  });

  test("links the PayPal extension instead of repeating it", () => {
    expect(page).toContain("/reference/ks1/");
  });
});
