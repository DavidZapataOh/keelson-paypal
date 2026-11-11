import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { clientCredentials, DEFAULT_BASE_URL, tokenRequest } from "./auth.ts";
import { APIError, AuthenticationError } from "./errors.ts";
import type { AuthProvider } from "./transport.ts";

/** What `npx keelson login` saves; the Python SDK reads and writes the same file. */
export interface Credentials {
  apiUrl: string;
  clientId: string;
  refreshToken: string;
  accessToken: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

/** `$XDG_CONFIG_HOME/keelson/credentials.json`, or `~/.config/keelson/credentials.json`. */
export function credentialsPath(): string {
  if (process.env.KEELSON_CREDENTIALS) return process.env.KEELSON_CREDENTIALS;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "keelson", "credentials.json");
}

export async function readCredentials(
  path: string = credentialsPath(),
): Promise<Credentials | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Credentials;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Writes the file readable by its owner only, through a rename so no reader sees half of it. */
export async function writeCredentials(
  credentials: Credentials,
  path: string = credentialsPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
}

/**
 * Runs `fn` holding `<path>.lock`, so one process at a time refreshes: a refresh token is rotated
 * on use, and a second refresh with the old one would end the sign-in everywhere.
 */
async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let waited = 0; ; waited += 50) {
    try {
      const handle = await open(lock, "wx", 0o600);
      await handle.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // A lock older than a refresh can take was left by a process that died holding it.
      const age =
        Date.now() -
        (await stat(lock).then(
          (st) => st.mtimeMs,
          () => Date.now(),
        ));
      if (age > 30_000 || waited > 30_000) await rm(lock, { force: true });
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lock).catch(() => {});
  }
}

/** One refresh per credentials file in this process at a time. */
const refreshing = new Map<string, Promise<string>>();

const RELOGIN = "Your Keelson sign-in has ended. Run `npx keelson login` again.";

/**
 * The user's sign-in that `npx keelson login` saved. The file is read on every call, so a token
 * another process refreshed is used instead of refreshing again.
 */
export function storedLogin(o: { path?: string } = {}): AuthProvider {
  const path = o.path ?? credentialsPath();
  let handedOut: string | undefined;
  return {
    async token({ force = false } = {}) {
      const c = await readCredentials(path);
      if (!c) throw noCredentials();
      const fresh = Date.now() < c.expiresAt - 30_000;
      if (fresh && (!force || c.accessToken !== handedOut)) {
        handedOut = c.accessToken;
        return c.accessToken;
      }
      const shared = refreshing.get(path);
      if (shared) return (handedOut = await shared);
      const refresh = withLock(path, async () => {
        // Another process may have refreshed while this one waited for the lock.
        const now = await readCredentials(path);
        if (!now) throw noCredentials();
        if (now.accessToken !== c.accessToken && Date.now() < now.expiresAt - 30_000) {
          return now.accessToken;
        }
        let t: Awaited<ReturnType<typeof tokenRequest>>;
        try {
          t = await tokenRequest(now.apiUrl, {
            grant_type: "refresh_token",
            refresh_token: now.refreshToken,
            client_id: now.clientId,
          });
        } catch (err) {
          if (err instanceof APIError && err.type === "invalid_grant") {
            throw new AuthenticationError(
              401,
              { error: "invalid_grant", error_description: RELOGIN },
              err.requestId,
            );
          }
          throw err;
        }
        await writeCredentials(
          {
            ...now,
            accessToken: t.access_token,
            refreshToken: t.refresh_token ?? now.refreshToken,
            expiresAt: Date.now() + t.expires_in * 1000,
          },
          path,
        );
        return t.access_token;
      });
      refreshing.set(path, refresh);
      try {
        handedOut = await refresh;
      } finally {
        refreshing.delete(path);
      }
      return handedOut;
    },
  };
}

const noCredentials = () =>
  new AuthenticationError(
    401,
    {
      error: "no_credentials",
      error_description: "No Keelson credentials. Run `npx keelson login`.",
    },
    null,
  );

/**
 * Where the SDK finds credentials when none are passed: `KEELSON_CLIENT_ID` and
 * `KEELSON_CLIENT_SECRET`, then `KEELSON_TOKEN`, then the saved sign-in.
 */
export function resolveAuth(baseUrl: string = DEFAULT_BASE_URL): AuthProvider {
  const {
    KEELSON_CLIENT_ID: id,
    KEELSON_CLIENT_SECRET: secret,
    KEELSON_TOKEN: token,
  } = process.env;
  if (id && secret) return clientCredentials({ clientId: id, clientSecret: secret, baseUrl });
  if (token) return { token: async () => token };
  return storedLogin();
}
