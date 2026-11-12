import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = fileURLToPath(new URL("../../../../", import.meta.url));

const walk = (dir: string, ext: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
        d.isDirectory()
          ? walk(join(dir, d.name), ext)
          : d.name.endsWith(ext)
            ? [join(dir, d.name)]
            : [],
      )
    : [];

/** The README, every page of the site and the pages still in docs/. */
export function docFiles(): string[] {
  return [
    join(REPO, "README.md"),
    ...walk(join(REPO, "apps/docs/src/content/docs"), ".mdoc"),
    ...walk(join(REPO, "docs"), ".md"),
  ];
}

export interface Fence {
  line: number;
  lang: string;
  info: string;
  body: string;
}

/** Every fenced block, with the 1-based line of its opening fence. */
export function fences(markdown: string): Fence[] {
  const out: Fence[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i]?.match(/^```(\S*)(.*)$/);
    if (!open) continue;
    const start = i;
    const body: string[] = [];
    for (i++; i < lines.length && !lines[i]?.startsWith("```"); i++) body.push(lines[i] ?? "");
    out.push({
      line: start + 1,
      lang: open[1] ?? "",
      info: (open[2] ?? "").trim(),
      body: body.join("\n"),
    });
  }
  return out;
}

export const extractMermaid = (markdown: string) =>
  fences(markdown)
    .filter((f) => f.lang === "mermaid")
    .map((f) => ({ line: f.line, code: f.body }));

export const extractLinks = (markdown: string) =>
  [...markdown.matchAll(/\]\(([^)\s]+)\)|<(https?:\/\/[^>\s]+)>/g)].map(
    (m) => (m[1] ?? m[2]) as string,
  );
