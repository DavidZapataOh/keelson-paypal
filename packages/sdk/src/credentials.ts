import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
  await writeFile(tmp, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

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
      let t: Awaited<ReturnType<typeof tokenRequest>>;
      try {
        t = await tokenRequest(c.apiUrl, {
          grant_type: "refresh_token",
          refresh_token: c.refreshToken,
          client_id: c.clientId,
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
          ...c,
          accessToken: t.access_token,
          refreshToken: t.refresh_token ?? c.refreshToken,
          expiresAt: Date.now() + t.expires_in * 1000,
        },
        path,
      );
      handedOut = t.access_token;
      return t.access_token;
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
