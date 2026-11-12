import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname } from "node:os";
import { AUDIENCE, DEFAULT_BASE_URL, tokenRequest } from "./auth.ts";
import {
  type Credentials,
  credentialsPath,
  readCredentials,
  writeCredentials,
} from "./credentials.ts";
import { errorFor, KeelsonError } from "./errors.ts";
import { checkBaseUrl } from "./transport.ts";

/** What a developer's own sign-in may do: ask for mandates and buy under them. */
export const LOGIN_SCOPES: readonly string[] = [
  "mandates:request",
  "evidence:write",
  "purchases:write",
  "alibis:read",
  "offline_access",
];

/** The redirect registered once; the port is chosen per sign-in (RFC 8252 §7.3). */
const REDIRECT = "http://127.0.0.1/callback";

export interface LoginOptions {
  baseUrl?: string;
  /** Opens the sign-in page; by default the system browser. The URL is printed either way. */
  open?: (url: string) => void | Promise<void>;
  scopes?: readonly string[];
  /** Where to save the sign-in. */
  path?: string;
  /** Gives up after this long; 10 minutes by default. */
  timeoutMs?: number;
  log?: (line: string) => void;
}

const b64url = (b: Buffer) => b.toString("base64url");

async function register(baseUrl: string, scopes: readonly string[]): Promise<string> {
  const res = await fetch(new URL("/api/auth/oauth2/register", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: `Keelson CLI on ${hostname()}`.slice(0, 64),
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: scopes.join(" "),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw errorFor(res.status, body, res.headers.get("x-request-id"));
  return body.client_id as string;
}

async function openInBrowser(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
}

/**
 * Signs the developer in from the terminal: OAuth 2.1 with PKCE (S256) through the system browser
 * and a one-time listener on 127.0.0.1 (RFC 8252), then saves the sign-in for the SDK to use.
 */
export async function login(o: LoginOptions = {}): Promise<Credentials> {
  const baseUrl = checkBaseUrl(o.baseUrl ?? process.env.KEELSON_API_URL ?? DEFAULT_BASE_URL).origin;
  const path = o.path ?? credentialsPath();
  const scopes = o.scopes ?? LOGIN_SCOPES;
  const log = o.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const saved = await readCredentials(path);
  const clientId =
    saved?.apiUrl === baseUrl && saved.clientId ? saved.clientId : await register(baseUrl, scopes);

  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(16));
  let settle!: { resolve: (code: string) => void; reject: (err: Error) => void };
  const codePromise = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    // Only an answer carrying this sign-in's state counts; anything else on this machine that
    // hits the listener is turned away and the sign-in keeps waiting.
    const ours = url.searchParams.get("state") === state;
    const ok = ours && !error && code;
    res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><title>Keelson</title><p style="font:16px system-ui;margin:3rem">${
        ok ? "Signed in. You can close this tab." : "Sign-in failed. Run npx keelson login again."
      }</p>`,
    );
    if (!ours) return;
    if (ok) settle.resolve(code);
    else settle.reject(new KeelsonError(`Sign-in failed: ${error ?? "no code"}`));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
  const timer = setTimeout(
    () => settle.reject(new KeelsonError("Sign-in timed out.")),
    o.timeoutMs ?? 600_000,
  );
  try {
    const authorize = new URL("/api/auth/oauth2/authorize", baseUrl);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scopes.join(" "),
      state,
      code_challenge: b64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      resource: AUDIENCE,
    }).toString();
    log(`Sign in to Keelson in your browser:\n  ${authorize.href}`);
    await (o.open ?? openInBrowser)(authorize.href);
    const code = await codePromise;
    const t = await tokenRequest(baseUrl, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    });
    if (!t.refresh_token) throw new KeelsonError("The sign-in returned no refresh token.");
    const credentials: Credentials = {
      apiUrl: baseUrl,
      clientId,
      refreshToken: t.refresh_token,
      accessToken: t.access_token,
      expiresAt: Date.now() + t.expires_in * 1000,
    };
    await writeCredentials(credentials, path);
    log(`Signed in. Saved to ${path}`);
    return credentials;
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    server.close();
  }
}
