import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";

const root = new URL("./pages/", import.meta.url).pathname;
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
};

/** Serves `test/pages` on a random local port. */
export async function serve(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    const path = normalize(new URL(req.url ?? "/", "http://localhost").pathname).replace(
      /^\/+/,
      "",
    );
    try {
      const body = await readFile(join(root, path));
      res.writeHead(200, {
        "content-type": TYPES[extname(path)] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
