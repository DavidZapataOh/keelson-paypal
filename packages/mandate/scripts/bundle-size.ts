import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { build, type Metafile, type Plugin } from "esbuild";

/** Initial JavaScript budget of `@keelson/mandate/browser`, gzipped. */
export const INITIAL_BUDGET_BYTES = 60 * 1024;

/**
 * bb.js picks its multi-threaded wasm only on cross-origin isolated pages (COOP + COEP). The app
 * is not isolated, so the app build drops that copy and keeps the single-threaded one.
 */
export const singleThreadedBb: Plugin = {
  name: "single-threaded-bb",
  setup(b) {
    b.onResolve({ filter: /barretenberg-threads\.js$/ }, (args) => ({
      path: args.path,
      namespace: "bb-threads",
    }));
    b.onLoad({ filter: /.*/, namespace: "bb-threads" }, () => ({
      contents:
        'throw new Error("multi-threaded bb.js is not bundled: serve the app without cross-origin isolation");',
      loader: "js",
    }));
  },
};

const WASM_MARKER = "data:application/gzip;base64,";

export interface BundleReport {
  /** Gzipped bytes of the entry and every chunk it imports statically. */
  initialGzip: number;
  /** Raw and gzipped bytes of the chunks holding bb.js wasm. */
  wasmChunks: { file: string; bytes: number; gzip: number; initial: boolean }[];
  totalBytes: number;
  exports: string[];
}

/** Bundles `src/browser.ts` as the app would (browser, ESM, minified, code splitting). */
export async function measureBrowserBundle(): Promise<BundleReport> {
  const cwd = new URL("..", import.meta.url).pathname;
  const result = await build({
    absWorkingDir: cwd,
    entryPoints: [new URL("../src/browser.ts", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "browser",
    splitting: true,
    minify: true,
    outdir: "out",
    write: false,
    metafile: true,
    logLevel: "error",
    plugins: [singleThreadedBb],
  });
  const metafile = result.metafile as Metafile;
  const contents = new Map(result.outputFiles.map((f) => [f.path, f]));
  const [entryPath, entry] = Object.entries(metafile.outputs).find(([, o]) => o.entryPoint) ?? [];
  if (!entryPath || !entry) throw new Error("no entry output");
  const initial = new Set<string>();
  const visit = (path: string) => {
    if (initial.has(path)) return;
    initial.add(path);
    for (const i of metafile.outputs[path]?.imports ?? []) {
      if (i.kind === "import-statement") visit(i.path);
    }
  };
  visit(entryPath);
  const file = (path: string) => contents.get(resolve(cwd, path));
  const gzip = (path: string) => gzipSync(file(path)?.contents ?? new Uint8Array()).length;
  const wasmChunks = Object.keys(metafile.outputs)
    .filter((path) => file(path)?.text.includes(WASM_MARKER))
    .map((path) => ({
      file: path,
      bytes: file(path)?.contents.length ?? 0,
      gzip: gzip(path),
      initial: initial.has(path),
    }));
  return {
    initialGzip: [...initial].reduce((n, p) => n + gzip(p), 0),
    wasmChunks,
    totalBytes: result.outputFiles.reduce((n, f) => n + f.contents.length, 0),
    exports: entry.exports,
  };
}

if (import.meta.main) {
  const r = await measureBrowserBundle();
  console.log(JSON.stringify(r, null, 2));
}
