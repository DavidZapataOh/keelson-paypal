import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const self = "packages/sdk/test/names.test.ts";

/** The published packages live under @keelson-finance; @keelson/* names stay internal. */
const OLD = /@keelson(?:\/|\\\/)(sdk|verifier|context)(?![-a-z])/;

test("no public reference names a published package under the @keelson scope", () => {
  const files = execFileSync("git", ["ls-files"], { cwd: repo, encoding: "utf8" })
    .split("\n")
    .filter((f) => f && f !== self && f !== "pnpm-lock.yaml")
    .filter((f) =>
      /\.(ts|tsx|mts|mjs|js|json|md|mdoc|mdx|astro|yml|yaml|txt|py|toml|html|sh)$/.test(f),
    );
  const offenders = files.flatMap((f) =>
    readFileSync(join(repo, f), "utf8")
      .split("\n")
      .flatMap((line, i) => (OLD.test(line) ? [`${f}:${i + 1}: ${line.trim()}`] : [])),
  );
  expect(offenders).toEqual([]);
});

test("the published packages are named under @keelson-finance and the rest are private", () => {
  const pkg = (dir: string) => JSON.parse(readFileSync(join(repo, dir, "package.json"), "utf8"));
  expect(pkg("packages/sdk").name).toBe("@keelson-finance/sdk");
  expect(pkg("packages/verify").name).toBe("@keelson-finance/verifier");
  expect(pkg("packages/context").name).toBe("@keelson-finance/context");
  const internal = execFileSync("git", ["ls-files", "*/package.json"], {
    cwd: repo,
    encoding: "utf8",
  })
    .split("\n")
    .filter((f) => f && !/^packages\/(sdk|verify|context)\//.test(f))
    .map((f) => JSON.parse(readFileSync(join(repo, f), "utf8")))
    .filter((p) => typeof p.name === "string" && p.name.startsWith("@keelson/"));
  expect(internal.filter((p) => p.private !== true).map((p) => p.name)).toEqual([]);
});
