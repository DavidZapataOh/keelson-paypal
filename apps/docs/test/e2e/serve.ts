import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("../../dist", import.meta.url));
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".wasm": "application/wasm",
};

async function resolve(path: string): Promise<string | undefined> {
  const file = join(DIST, normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, ""));
  const info = await stat(file).catch(() => undefined);
  if (info?.isFile()) return file;
  if (info?.isDirectory()) return resolve(join(path, "index.html"));
  return undefined;
}

/** Serves the built site over HTTP, as a static host would. */
export async function startPreview(): Promise<{ url: string; stop(): Promise<void> }> {
  const server = createServer(async (req, res) => {
    const file = await resolve(new URL(req.url ?? "/", "http://x").pathname);
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(await readFile(file));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise((ok) => server.close(() => ok())),
  };
}
