import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { extractMermaid, REPO } from "./lib/markdown";

const page = readFileSync(
  join(REPO, "apps/docs/src/content/docs/security/threat-model.mdoc"),
  "utf8",
);
const h2 = [...page.matchAll(/^## (.+?)(?:\s+\{%.*%\})?$/gm)].map((m) => m[1]);
const table = (heading: string) => {
  const part = page.split(/^## /m).find((s) => s.startsWith(heading)) ?? "";
  return part.split("\n").filter((l) => l.startsWith("|") && !/^\|\s*-/.test(l));
};
const cells = (row: string) =>
  row
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim());

describe("the threat model", () => {
  test("is organised as guarantees, actors, boundaries, compromises, attacks and limits", () => {
    expect(h2).toEqual([
      "What an Alibi guarantees",
      "What it does not guarantee",
      "Actors",
      "Trust boundaries",
      "Compromises, by impact",
      "Attacks and defenses",
      "Limits",
      "Reporting a vulnerability",
    ]);
  });

  test("marks at least three compromisable steps in its diagram", () => {
    const d = extractMermaid(page)
      .map((x) => x.code)
      .join("\n");
    expect(d).toMatch(/classDef compromisable/);
    expect(
      (d.match(/:::compromisable|class [^\n]+ compromisable/g) ?? []).length,
    ).toBeGreaterThanOrEqual(3);
  });

  test("ranks compromises by impact, highest first, covering every component", () => {
    const [head, ...rows] = table("Compromises, by impact");
    expect(cells(head ?? "")).toEqual([
      "Compromise",
      "Attacker can",
      "Attacker cannot",
      "Detected by",
      "Impact",
    ]);
    const rank = ["Critical", "High", "Medium", "Low"];
    const impacts = rows.map((r) => rank.indexOf(cells(r)[4] ?? ""));
    expect(impacts.every((i) => i >= 0)).toBe(true);
    expect([...impacts].sort((a, b) => a - b)).toEqual(impacts);
    const names = rows.map((r) => cells(r)[0]?.toLowerCase() ?? "").join("\n");
    for (const c of [
      "one tee leg",
      "both tee legs",
      "log operator",
      "one witness",
      "all keelson witnesses",
      "passkey",
      "agent operator",
      "merchant",
      "paypal",
      "relayer",
      "rpc",
    ]) {
      expect(names, c).toContain(c);
    }
  });

  test("gives every defense a proof a reader can follow", () => {
    const [, ...rows] = table("Attacks and defenses");
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const r of rows) {
      const proof = cells(r).at(-1) ?? "";
      const link = proof.match(/\]\(([^)]+)\)/)?.[1] ?? proof.match(/`([^`]+)`/)?.[1] ?? "";
      const ok =
        link.startsWith("/security/verify/#") ||
        link.startsWith("https://") ||
        existsSync(join(REPO, link));
      expect(ok, `${cells(r)[0]}: ${proof}`).toBe(true);
    }
  });

  test("states every limit plainly", () => {
    const limits = page.split(/^## Limits/m)[1] ?? "";
    for (const k of [
      "PayPal adjudicates",
      "not insurance",
      "sandbox",
      "not independent",
      "never green",
      "Lean model",
      "testimony",
      "TEE.fail",
      "drafts",
      "passkey",
      "Chromium",
      "Two flows",
    ]) {
      expect(limits, k).toContain(k);
    }
  });
});
