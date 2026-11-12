import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { extractChecks } from "./lib/checks";
import { REPO } from "./lib/markdown";

const FILE = join(REPO, "apps/docs/src/content/docs/security/verify.mdoc");
const SECTIONS = [
  "tee-image",
  "leg-a-tdx",
  "leg-b-nitro",
  "log-checkpoint",
  "witnesses",
  "sigsum",
  "anchor",
  "log-bond",
  "contracts",
  "zk-verifiers",
  "paypal-sandbox",
  "monitor",
];
const TWO_PATHS = ["leg-a-tdx", "leg-b-nitro", "log-checkpoint", "anchor"];
const slug = (h: string) =>
  h
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

function sections() {
  const text = readFileSync(FILE, "utf8");
  const parts = text.split(/^## /m).slice(1);
  return parts.map((p) => {
    const [heading = "", ...rest] = p.split("\n");
    const id = heading.match(/\{%\s*#([a-z0-9-]+)\s*%\}/)?.[1] ?? slug(heading);
    return { id, checks: extractChecks(`\n${rest.join("\n")}`, FILE).map((c) => c.id) };
  });
}

describe("verify every claim", () => {
  test("has exactly the claim sections, in order", () => {
    expect(
      sections()
        .map((s) => s.id)
        .filter((id) => id !== "how-these-are-checked"),
    ).toEqual(SECTIONS);
  });

  test("every claim carries at least one check", () => {
    for (const s of sections().filter((s) => SECTIONS.includes(s.id)))
      expect(s.checks.length, s.id).toBeGreaterThan(0);
  });

  test("TEE, log and anchor claims have a path through the API and one that trusts no Keelson server", () => {
    const byId = new Map(sections().map((s) => [s.id, s.checks]));
    for (const id of TWO_PATHS)
      expect(byId.get(id)).toEqual(expect.arrayContaining([`${id}-api`, `${id}-local`]));
  });
});
