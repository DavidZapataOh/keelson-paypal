import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export type Reply = (res: ServerResponse, seen: Seen) => void;

/** A real HTTP server on 127.0.0.1 that answers each request with the next scripted reply. */
export async function scriptedServer(): Promise<{
  url: string;
  seen: Seen[];
  script: (...replies: Reply[]) => void;
  close: () => Promise<void>;
}> {
  const seen: Seen[] = [];
  let queue: Reply[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString();
    });
    req.on("end", () => {
      const s = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      seen.push(s);
      const next = queue.shift();
      if (next) next(res, s);
      else json(500, { title: "unscripted" })(res, s);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    script: (...replies) => {
      seen.length = 0;
      queue = replies;
    },
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export const json =
  (status: number, body: unknown, headers: Record<string, string> = {}): Reply =>
  (res) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };

export const problem = (
  status: number,
  slug: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Reply =>
  json(
    status,
    {
      type: `https://api.keelson.finance/problems/${slug}`,
      title: slug.replaceAll("-", " "),
      status,
      instance: "/",
      ...extra,
    },
    { "content-type": "application/problem+json", "x-request-id": "req_1", ...headers },
  );

/** Destroys the socket before any answer: the request may or may not have been processed. */
export const drop: Reply = (res) => {
  res.socket?.destroy();
};

/** Never answers. */
export const hang: Reply = () => {};
