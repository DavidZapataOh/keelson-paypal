import { gzipSync } from "node:zlib";
import { build } from "esbuild";

/** Bundles `verifyTimestamp` as a browser application would: ESM source, minified, one script. */
export async function bundleTimestamp(): Promise<{ code: string; bytes: number; gzip: number }> {
  const result = await build({
    stdin: {
      contents: 'export { verifyTimestamp } from "./src/verify.ts";',
      resolveDir: new URL("..", import.meta.url).pathname,
      loader: "ts",
    },
    bundle: true,
    minify: true,
    platform: "browser",
    format: "iife",
    globalName: "timestamp",
    target: "es2024",
    write: false,
    logLevel: "error",
  });
  const code = result.outputFiles[0]?.text ?? "";
  return { code, bytes: Buffer.byteLength(code), gzip: gzipSync(code).length };
}
