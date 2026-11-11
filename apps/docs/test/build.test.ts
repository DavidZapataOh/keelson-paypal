import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";

const app = fileURLToPath(new URL("..", import.meta.url));
const repo = join(app, "../..");
const dist = (...p: string[]) => join(app, "dist", ...p);
const read = (...p: string[]) => readFileSync(dist(...p), "utf8");
const FIXTURES = ["01M6ZWZJHWRRHQEYNJAT7NMSV8", "01M6ZX07MFWDDDW4199FDJHWEG"];

function entries(dir = join(app, "src/content/docs"), prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (d.name.startsWith("_")) return [];
    if (d.isDirectory()) return entries(join(dir, d.name), `${prefix}${d.name}/`);
    return d.name.endsWith(".mdoc") ? [`${prefix}${d.name.replace(/\.mdoc$/, "")}`] : [];
  });
}
const body = (id: string) =>
  readFileSync(join(app, "src/content/docs", `${id}.mdoc`), "utf8").replace(
    /^---\n[\s\S]*?\n---\n+/,
    "",
  );

describe("the built site", () => {
  test("has a home page", () => {
    expect(existsSync(dist("index.html"))).toBe(true);
  });

  test("llms.txt opens with agent instructions and lists every page", () => {
    const llms = read("llms.txt");
    expect(llms.startsWith("# Keelson\n")).toBe(true);
    expect(llms).toContain("Use the PayPal sandbox");
    expect(llms).toContain("https://api.keelson.finance/mcp");
    for (const id of entries()) {
      const slug = id === "index" ? "index" : id;
      expect(llms).toMatch(
        new RegExp(`- \\[[^\\]]+\\]\\(https://docs\\.keelson\\.finance/${slug}\\.md\\): \\S`),
      );
    }
  });

  test("llms-full.txt and the .md pages carry each page's Markdoc body", () => {
    const full = read("llms-full.txt");
    for (const id of entries()) {
      expect(full).toContain(body(id).trim());
      expect(read(`${id}.md`)).toBe(body(id));
    }
  });

  test("serves the OpenAPI document as JSON and YAML", () => {
    const yaml = parse(readFileSync(join(repo, "openapi/keelson.yaml"), "utf8"));
    const json = JSON.parse(read("openapi.json"));
    expect(json.openapi).toBe("3.1.0");
    expect(Object.keys(json.paths)).toHaveLength(Object.keys(yaml.paths).length);
    expect(read("openapi.yaml")).toBe(readFileSync(join(repo, "openapi/keelson.yaml"), "utf8"));
  });

  test("serves the committed sample Alibis byte for byte", () => {
    for (const id of FIXTURES) {
      expect(readFileSync(dist("samples", `${id}.alibi`))).toEqual(
        readFileSync(join(repo, "packages/alibi/test/fixtures", `${id}.alibi`)),
      );
    }
  });

  test("has a Pagefind index", () => {
    expect(existsSync(dist("pagefind", "pagefind.js"))).toBe(true);
  });
});

describe("Markdoc validation", () => {
  test("an unknown callout type fails the build", () => {
    const page = join(app, "src/content/docs/invalid-callout.mdoc");
    const out = mkdtempSync(join(tmpdir(), "docs-invalid-"));
    writeFileSync(
      page,
      '---\ntitle: Invalid\ndescription: Invalid.\nsection: Start\norder: 99\n---\n\n{% callout type="danger" %}\nNo.\n{% /callout %}\n',
    );
    try {
      expect(() =>
        execFileSync("pnpm", ["exec", "astro", "build", "--outDir", out], {
          cwd: app,
          stdio: "pipe",
        }),
      ).toThrow();
    } finally {
      rmSync(page, { force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });
});
