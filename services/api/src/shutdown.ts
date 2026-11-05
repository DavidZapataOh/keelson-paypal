import type { Server } from "node:http";
import type { ServerType } from "@hono/node-server";

const SWEEP_MS = 50;

/**
 * Ends every open event stream, then stops the server. `server.close()` only closes connections
 * that are idle when it is called, and a keep-alive connection whose response ends later would
 * stay open until `keepAliveTimeout`, so idle connections are swept until the server has closed.
 * In-flight requests are left to finish.
 */
export function closeServer(server: ServerType, streams: AbortController): Promise<void> {
  const http = server as Server;
  streams.abort();
  return new Promise((resolve, reject) => {
    const sweep = setInterval(() => http.closeIdleConnections(), SWEEP_MS);
    http.close((err) => {
      clearInterval(sweep);
      if (err) reject(err);
      else resolve();
    });
  });
}
