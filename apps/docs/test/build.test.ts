import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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

  test("has every page the app's developer guide links to", () => {
    const steps = readFileSync(join(repo, "apps/web/components/developers/steps.ts"), "utf8");
    const linked = [...steps.matchAll(/`\$\{DOCS\}(\/[a-z0-9/-]+)`/g)].map((m) => m[1] as string);
    expect(linked).toEqual([
      "/sdk/install",
      "/sdk/authentication",
      "/sdk/mandates",
      "/sdk/purchases",
      "/sdk/verify",
    ]);
    for (const path of linked) expect(existsSync(dist(path, "index.html")), path).toBe(true);
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

function htmlFiles(dir = dist()): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? htmlFiles(join(dir, d.name))
      : d.name.endsWith(".html")
        ? [join(dir, d.name)]
        : [],
  );
}
/** The page's readable prose: no scripts, styles, code, attributes or tags. */
const prose = (html: string) =>
  html
    .replace(/<(script|style|pre|code)\b[\s\S]*?<\/\1>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/g, " ");

describe("the copy", () => {
  test("writes Alibi as a proper noun", () => {
    const bad = htmlFiles()
      .map(
        (f) =>
          [
            f.slice(dist().length),
            prose(readFileSync(f, "utf8")).match(/(?<![.\w-])alibis?(?![.\w-])/g),
          ] as const,
      )
      .filter(([, m]) => m);
    expect(bad).toEqual([]);
  });

  test("shows durations rounded, not with machine precision", () => {
    const text = prose(
      read("reference/api/verifyAlibi/index.html").replace(/<\/?(pre|code)\b[^>]*>/g, ""),
    );
    expect(text.match(/\b\d+\.\d{4,}\b/g)).toBeNull();
  });
});

describe("the deployment", () => {
  test("the CSP in render.yaml allows exactly the inline scripts the pages carry", () => {
    const blueprint = parse(readFileSync(join(repo, "render.yaml"), "utf8")) as {
      services: { name: string; headers?: { path: string; name: string; value: string }[] }[];
    };
    const csp = blueprint.services
      .find((s) => s.name === "keelson-docs")
      ?.headers?.find((h) => h.name === "Content-Security-Policy")?.value;
    const scriptSrc = csp?.match(/script-src ([^;]+)/)?.[1] ?? "";
    const hashes = new Set(
      htmlFiles().flatMap((f) =>
        [
          ...readFileSync(f, "utf8").matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g),
        ].map(
          (m) =>
            `'sha256-${createHash("sha256")
              .update(m[1] ?? "")
              .digest("base64")}'`,
        ),
      ),
    );
    expect(hashes.size).toBeGreaterThan(0);
    for (const h of hashes) expect(scriptSrc).toContain(h);
    expect(scriptSrc).not.toContain("unsafe-inline");
  });
});

describe("Markdoc validation", () => {
  test("an unknown callout type fails the build", () => {
    const page = join(app, "src/content/docs/invalid-callout.mdoc");
    const out = mkdtempSync(join(tmpdir(), "docs-invalid-"));
    writeFileSync(
      page,
      '---\ntitle: Invalid\ndescription: Invalid.\nsection: Quickstart\norder: 99\n---\n\n{% callout type="danger" %}\nNo.\n{% /callout %}\n',
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
