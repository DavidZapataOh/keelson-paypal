import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { beforeAll, describe, expect, test } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");

describe("budgets", () => {
  beforeAll(() => {
    execFileSync("pnpm", ["run", "build"], { cwd: root, stdio: "ignore" });
  }, 120_000);

  test("the core entry is at most 30 KB minified and gzipped, and pulls in nothing heavy", async () => {
    const out = await build({
      stdin: { contents: 'export * from "./dist/index.js";', resolveDir: root },
      bundle: true,
      minify: true,
      platform: "node",
      format: "esm",
      write: false,
      metafile: true,
    });
    const bytes = out.outputFiles[0]?.contents as Uint8Array;
    const gz = gzipSync(bytes, { level: 9 }).byteLength;
    console.log(`@keelson/sdk core: ${bytes.byteLength} B min, ${gz} B min+gz`);
    expect(gz).toBeLessThanOrEqual(30 * 1024);
    const inputs = Object.keys(out.metafile.inputs).join(" ");
    expect(inputs).not.toMatch(/@aztec|cedar|viem|zod|jose|@langchain|@openai|claude-agent|\bai\//);
    expect(inputs).not.toMatch(/dist\/adapters\//);
  });

  test("installs in at most 2 MB with at most 3 runtime dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(Object.keys(pkg.dependencies).length).toBeLessThanOrEqual(3);
    const tmp = mkdtempSync(join(tmpdir(), "keelson-sdk-install-"));
    // pnpm pack writes the catalog versions into the packed manifest, as a publish would.
    execFileSync("pnpm", ["pack", "--pack-destination", tmp], { cwd: root, stdio: "ignore" });
    const tgz = readdirSync(tmp).find((f) => f.endsWith(".tgz")) as string;
    execFileSync("npm", ["init", "-y"], { cwd: tmp, stdio: "ignore" });
    execFileSync(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(tmp, tgz)],
      {
        cwd: tmp,
        stdio: "ignore",
      },
    );
    const size = (p: string): number =>
      statSync(p).isDirectory()
        ? readdirSync(p).reduce((s, n) => s + size(join(p, n)), 0)
        : statSync(p).size;
    const installed = size(join(tmp, "node_modules"));
    console.log(`@keelson/sdk installed: ${installed} B`);
    expect(installed).toBeLessThanOrEqual(2 * 1024 * 1024);
  }, 120_000);

  test("the public declarations have no any", () => {
    const files = readdirSync(dist, { recursive: true, encoding: "utf8" }).filter((f) =>
      f.endsWith(".d.ts"),
    );
    const offenders = files.filter((f) =>
      /(?<![/*@\w])\bany\b(?![\w-])/.test(
        readFileSync(join(dist, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""),
      ),
    );
    expect(offenders).toEqual([]);
  });

  test("the quickstart is at most 12 lines", () => {
    const lines = readFileSync(join(root, "examples/quickstart.mjs"), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    expect(lines.length).toBeLessThanOrEqual(12);
  });

  test("api-surface.json lists the built client's methods", () => {
    const surface = JSON.parse(readFileSync(join(root, "api-surface.json"), "utf8")) as string[];
    expect(surface).toContain("purchases.countersign");
    expect(surface).toContain("mandates.waitForApproval");
    expect(surface).toContain("alibis.retrieve");
    expect(surface).toContain("status");
  });
});
