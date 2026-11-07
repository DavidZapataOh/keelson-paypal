import { gzipSync } from "node:zlib";
import { build } from "esbuild";

/** Bundles `src/index.ts` as a browser application would: ESM source, minified, one script. */
export async function bundleAttest(): Promise<{ code: string; bytes: number; gzip: number }> {
  const result = await build({
    entryPoints: [new URL("../src/index.ts", import.meta.url).pathname],
    bundle: true,
    minify: true,
    platform: "browser",
    format: "iife",
    globalName: "attest",
    target: "es2024",
    write: false,
    logLevel: "error",
  });
  const code = result.outputFiles[0]?.text ?? "";
  return { code, bytes: Buffer.byteLength(code), gzip: gzipSync(code).length };
}
