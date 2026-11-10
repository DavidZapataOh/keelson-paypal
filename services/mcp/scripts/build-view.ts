// Builds the Alibi View as one self-contained HTML file (MCP Apps hosts render it in a sandboxed
// iframe without network), with the theme tokens of @keelson/ui as CSS variables.
import { readFileSync, writeFileSync } from "node:fs";
import { brand, fonts, motion, themes } from "@keelson/ui/tokens";
import { build } from "esbuild";

const vars = (o: Record<string, string>) =>
  Object.entries(o)
    .map(([k, v]) => `--${k}:${v};`)
    .join("");

/** Hosts may not load web fonts into the View; Chromium maps `ui-monospace` to nothing. */
const mono = fonts.mono.replace("ui-monospace,", 'ui-monospace, "SF Mono", Menlo, Consolas,');

/** The View's HTML. */
export async function buildView(): Promise<string> {
  const dir = new URL("../view/", import.meta.url);
  const script = await build({
    entryPoints: [new URL("alibi.ts", dir).pathname],
    bundle: true,
    minify: true,
    format: "esm",
    target: "es2022",
    platform: "browser",
    legalComments: "none",
    write: false,
  });
  const css = await build({
    entryPoints: [new URL("alibi.css", dir).pathname],
    minify: true,
    write: false,
  });
  const tokens = `:root{${vars(brand)}${vars(themes.light)}--font-sans:${fonts.sans};--font-mono:${mono};--ease-out:${motion["ease-out"]}}[data-theme="dark"]{${vars(themes.dark)}}`;
  return readFileSync(new URL("alibi.html", dir), "utf8")
    .replace("/*TOKENS*/", tokens)
    .replace("/*STYLES*/", css.outputFiles[0]?.text.trim() ?? "")
    .replace("/*SCRIPT*/", () =>
      (script.outputFiles[0]?.text.trim() ?? "").replaceAll("</script", "<\\/script"),
    );
}

if (import.meta.main) {
  writeFileSync(new URL("../dist/alibi.html", import.meta.url), await buildView());
}
