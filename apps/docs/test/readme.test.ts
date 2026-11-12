import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { extractChecks } from "./lib/checks";
import { REPO } from "./lib/markdown";

const file = join(REPO, "README.md");
const readme = readFileSync(file, "utf8");
const lines = readme.split("\n");
const section = (name: string) => readme.split(/^## /m).find((s) => s.startsWith(name)) ?? "";
const verifyAnchors = [
  ...readFileSync(join(REPO, "apps/docs/src/content/docs/security/verify.mdoc"), "utf8").matchAll(
    /\{% #([a-z0-9-]+) %\}/g,
  ),
].map((m) => m[1]);

describe("the README", () => {
  test("tells a judge what, where to click and how to verify in its first 15 lines", () => {
    const top = lines.slice(0, 15).join("\n");
    for (const url of [
      "https://app.keelson.finance/judge",
      "https://docs.keelson.finance",
      "https://docs.keelson.finance/quickstart/verify-an-alibi/",
    ]) {
      expect(top, url).toContain(url);
    }
    expect(/youtube\.com|youtu\.be/.test(top)).toBe(Boolean(process.env.DEMO_VIDEO_URL));
  });

  test("says what is sandbox in a callout within 25 lines", () => {
    const i = lines.findIndex((l) => l.trim() === "> [!IMPORTANT]");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(25);
    const quote = lines.slice(i, i + 6).join(" ");
    expect(quote).toContain("PayPal sandbox");
    expect(quote).toContain("Arbitrum Sepolia");
  });

  test("maps PayPal and AI to the code that uses them", () => {
    const rows = section("PayPal and AI, exactly where")
      .split("\n")
      .filter((l) => l.startsWith("|") && !/^\|\s*-/.test(l))
      .slice(1);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(10);
    const paths = rows.map((r) => r.split("|")[2]?.match(/`([^`]+)`/)?.[1] ?? "");
    for (const p of paths) expect(existsSync(join(REPO, p)), p).toBe(true);
    for (const p of ["packages/paypal", "services/agent", "packages/compiler"])
      expect(
        paths.some((x) => x.startsWith(p)),
        p,
      ).toBe(true);
  });

  test("lets a reader verify it, and links each claim to its check", () => {
    expect(extractChecks(readme, file).map((c) => c.id)).toContain("readme-verify");
    const links = [
      ...section("Verify it yourself").matchAll(
        /https:\/\/docs\.keelson\.finance\/security\/verify\/#([a-z0-9-]+)/g,
      ),
    ].map((m) => m[1]);
    expect(links.length).toBeGreaterThanOrEqual(6);
    for (const a of links) expect(verifyAnchors, a).toContain(a);
  });

  test("answers the questions judges ask", () => {
    const qs = [...section("Questions judges ask").matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    expect(qs).toEqual([
      "Why two TEEs?",
      "What if both TEEs are compromised?",
      "Isn't this PayPal Purchase Protection?",
      "How is this different from AP2 or ACP mandates?",
      "Who pays, and how much?",
    ]);
  });

  test("stays between 150 and 300 lines and never links into the site's sources", () => {
    expect(lines.length).toBeGreaterThanOrEqual(150);
    expect(lines.length).toBeLessThanOrEqual(300);
    expect(readme).not.toMatch(/\]\((\.\/)?apps\/docs\/src\/content/);
  });
});
