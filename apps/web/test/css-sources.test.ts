import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const WEB = join(import.meta.dirname, "..");
const UI = join(WEB, "../../packages/ui/src/components");

/** Every file under `dir` with one of `exts`. */
const files = (dir: string, exts: RegExp): string[] =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && exts.test(e.name))
    .map((e) => join(e.parentPath, e.name));

test("the stylesheet leaves out only shared components the app never renders", () => {
  const css = readFileSync(join(WEB, "app/globals.css"), "utf8");
  const list = /@source not "[^"]*\/components\/\{([^}]+)\}\.tsx";/.exec(css)?.[1];
  const skipped = new Set((list ?? "").split(","));
  expect(skipped.size).toBeGreaterThan(0);
  const used = new Set<string>();
  const add = (name: string) => {
    if (used.has(name)) return;
    used.add(name);
    const source = readFileSync(join(UI, `${name}.tsx`), "utf8");
    for (const m of source.matchAll(/#components\/([a-z-]+)/g)) add(m[1] as string);
  };
  for (const f of files(join(WEB, "app"), /\.tsx?$/).concat(
    files(join(WEB, "components"), /\.tsx?$/),
    files(join(WEB, "lib"), /\.tsx?$/),
  )) {
    for (const m of readFileSync(f, "utf8").matchAll(/@keelson\/ui\/components\/([a-z-]+)/g)) {
      add(m[1] as string);
    }
  }
  expect([...skipped].filter((c) => used.has(c))).toEqual([]);
});
