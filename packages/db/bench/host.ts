import { parse } from "pg-connection-string";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
// Default Unix-socket directories of the PostgreSQL builds we run locally (Homebrew, Debian, Docker).
const SOCKET_DIRS = new Set(["/tmp", "/var/run/postgresql"]);

/** Throws unless the host pg would actually connect to is local. */
export function assertLocalHost(connectionString: string): void {
  const url = new URL(connectionString);
  const { host } = parse(connectionString);
  if (url.searchParams.has("hostaddr") || !host) {
    throw new Error(`refusing to run the benchmark: ${host ?? "no host"}`);
  }
  if (!LOCAL_HOSTS.has(host) && !SOCKET_DIRS.has(host)) {
    throw new Error(`refusing to run the benchmark against host ${host}`);
  }
}
