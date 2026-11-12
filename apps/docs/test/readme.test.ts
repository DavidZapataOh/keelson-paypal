import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { extractChecks } from "./lib/checks";
import { REPO } from "./lib/markdown";

const file = join(REPO, "README.md");
const readme = readFileSync(file, "utf8");
const lines = readme.split("\n");
const section = (name: string) => readme.split(/^## /m).find((s) => s.startsWith(name)) ?? "";
const fences = (lang: string) =>
  [...readme.matchAll(new RegExp("```" + lang + "\\n([\\s\\S]*?)```", "g"))].map((m) => m[1] ?? "");

describe("the README", () => {
  test("says what Keelson is and links the docs, the verifier and a no-code trial in its first 15 lines", () => {
    const top = lines.slice(0, 15).join("\n");
    for (const url of [
      "https://docs.keelson.finance",
      "https://verify.keelson.finance",
      "https://app.keelson.finance/judge",
    ]) {
      expect(top, url).toContain(url);
    }
    expect(/youtube\.com|youtu\.be/.test(top)).toBe(Boolean(process.env.DEMO_VIDEO_URL));
  });

  test("says what is sandbox in a callout within 25 lines", () => {
    const i = lines.findIndex((l) => /^> \[!(NOTE|IMPORTANT)\]$/.test(l.trim()));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(25);
    const quote = lines.slice(i, i + 6).join(" ");
    expect(quote).toContain("PayPal sandbox");
    expect(quote).toContain("Arbitrum Sepolia");
  });

  test("installs the published packages and runs the same quickstart in TypeScript and Python", () => {
    const install = section("Install");
    expect(install).toContain("npm install @keelson-finance/sdk @keelson-finance/verifier");
    expect(install).toContain("pip install keelson-finance");
    const [js] = fences("js");
    const [py] = fences("python");
    for (const call of ["mandates.request", "evidence.seal", "purchases.countersign"]) {
      expect(js, call).toContain(call);
    }
    for (const call of ["mandates.request", "evidence.seal", "purchases.countersign"]) {
      expect(py, call).toContain(call);
    }
    expect(js).toContain("verifyAlibi");
    expect(py).toContain("verify_alibi");
  });

  test("lets a reader verify an Alibi with a checked command", () => {
    expect(extractChecks(readme, file).map((c) => c.id)).toContain("readme-verify");
  });

  test("links every package to a path that exists and names how PayPal and AI are used", () => {
    const paths = [...section("Packages").matchAll(/\]\(((?:packages|openapi)\/[^)#]+)/g)].map(
      (m) => m[1] ?? "",
    );
    expect(paths.length).toBeGreaterThanOrEqual(4);
    for (const p of paths) expect(existsSync(join(REPO, p)), p).toBe(true);
    const built = section("Built with");
    for (const word of ["PayPal", "Claude", "Render", "AG Grid", "KERNEL"]) {
      expect(built, word).toContain(word);
    }
  });

  test("stays between 150 and 300 lines and never links into the site's sources", () => {
    expect(lines.length).toBeGreaterThanOrEqual(150);
    expect(lines.length).toBeLessThanOrEqual(300);
    expect(readme).not.toMatch(/\]\((\.\/)?apps\/docs\/src\/content/);
  });
});
