import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

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

const blueprint = parse(
  readFileSync(fileURLToPath(new URL("../../../../render.yaml", import.meta.url)), "utf8"),
) as {
  services: { name: string; headers?: { path: string; name: string; value: string }[] }[];
};
/** The headers render.yaml gives every page of the docs site, so tests run under the real CSP. */
const HEADERS = Object.fromEntries(
  (blueprint.services.find((s) => s.name === "keelson-docs")?.headers ?? [])
    .filter((h) => h.path === "/*")
    .map((h) => [h.name, h.value]),
);

/** Serves the built site over HTTP, as Render serves it: same files, same headers. */
export async function startPreview(): Promise<{ url: string; stop(): Promise<void> }> {
  const server = createServer(async (req, res) => {
    const file = await resolve(new URL(req.url ?? "/", "http://x").pathname);
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      ...HEADERS,
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    });
    res.end(await readFile(file));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise((ok) => server.close(() => ok())),
  };
}
