/** Keelson's API: the resource (RFC 8707) every access token is requested for. */
export const KEELSON_API = "https://api.keelson.finance";

/** Supplies the bearer token of each request. */
export interface TokenProvider {
  /** A token valid now, fetched or refreshed when needed. */
  token(): Promise<string>;
  /** Drops the cached token after the API refused it, so the next call gets a fresh one. */
  invalidate(): void;
}

/** The tokens an authorization server answered (RFC 6749 §5.1). */
export interface TokenSet {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  refreshToken?: string;
  scope?: string;
}

/** An OAuth error answered by the authorization server (RFC 6749 §5.2). */
export class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly description?: string,
  ) {
    super(description ? `${error}: ${description}` : error);
    this.name = "OAuthError";
  }
}

/** Refresh this long before a token expires. */
const EARLY_MS = 60_000;

const authServer = (baseUrl: string) => `${baseUrl.replace(/\/$/, "")}/api/auth`;

async function tokenRequest(
  baseUrl: string,
  body: Record<string, string>,
  headers: Record<string, string> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<TokenSet> {
  const res = await fetchImpl(`${authServer(baseUrl)}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof json.access_token !== "string") {
    throw new OAuthError(
      res.status,
      typeof json.error === "string" ? json.error : `http_${res.status}`,
      typeof json.error_description === "string" ? json.error_description : undefined,
    );
  }
  return {
    accessToken: json.access_token,
    expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000,
    ...(typeof json.refresh_token === "string" ? { refreshToken: json.refresh_token } : {}),
    ...(typeof json.scope === "string" ? { scope: json.scope } : {}),
  };
}

function cached(fetchToken: () => Promise<TokenSet>): TokenProvider {
  let current: TokenSet | undefined;
  let pending: Promise<TokenSet> | undefined;
  return {
    async token() {
      if (current && Date.now() < current.expiresAt - EARLY_MS) return current.accessToken;
      pending ??= fetchToken().finally(() => {
        pending = undefined;
      });
      current = await pending;
      return current.accessToken;
    },
    invalidate() {
      current = undefined;
    },
  };
}

export interface ClientCredentialsOptions {
  clientId: string;
  clientSecret: string;
  /** The scopes to ask for, e.g. `countersign:write evidence:write`. */
  scopes: readonly string[];
  /** Defaults to {@link KEELSON_API}. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * An operator's agent acting for itself: the client credentials grant (RFC 6749 §4.4) with
 * `client_secret_basic`, for Keelson's API as the resource. The token is kept until a minute
 * before it expires.
 */
export function clientCredentials(o: ClientCredentialsOptions): TokenProvider {
  const baseUrl = o.baseUrl ?? KEELSON_API;
  const basic = btoa(`${encodeURIComponent(o.clientId)}:${encodeURIComponent(o.clientSecret)}`);
  return cached(() =>
    tokenRequest(
      baseUrl,
      { grant_type: "client_credentials", scope: o.scopes.join(" "), resource: KEELSON_API },
      { authorization: `Basic ${basic}` },
      o.fetch,
    ),
  );
}

export interface PublicClientRegistration {
  clientName: string;
  redirectUris: readonly string[];
  /** Defaults to the delegated scopes Keelson grants an app. */
  scopes?: readonly string[];
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** The scopes an app acting for a user may hold. */
export const DELEGATED_SCOPES = [
  "mandates:request",
  "evidence:write",
  "purchases:write",
  "alibis:read",
  "offline_access",
] as const;

/**
 * Registers an app as a public client (RFC 7591, `token_endpoint_auth_method: none`), as MCP hosts
 * do. Returns its `client_id`.
 */
export async function registerPublicClient(o: PublicClientRegistration): Promise<string> {
  const res = await (o.fetch ?? fetch)(`${authServer(o.baseUrl ?? KEELSON_API)}/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: o.clientName,
      redirect_uris: o.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: (o.scopes ?? DELEGATED_SCOPES).join(" "),
    }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof json.client_id !== "string") {
    throw new OAuthError(
      res.status,
      typeof json.error === "string" ? json.error : `http_${res.status}`,
      typeof json.error_description === "string" ? json.error_description : undefined,
    );
  }
  return json.client_id;
}

export interface AuthorizationRequest {
  /** Send the user here; Keelson redirects back to `redirectUri` with `code` and `state`. */
  url: string;
  /** Keep it for {@link exchangeCode}; never send it anywhere else. */
  codeVerifier: string;
  state: string;
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/**
 * Starts the authorization code grant with PKCE (RFC 7636, S256) for an app acting for a user,
 * with Keelson's API as the resource (RFC 8707).
 */
export async function createAuthorizationRequest(o: {
  clientId: string;
  redirectUri: string;
  scopes?: readonly string[];
  baseUrl?: string;
}): Promise<AuthorizationRequest> {
  const codeVerifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier)),
  );
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const url = new URL(`${authServer(o.baseUrl ?? KEELSON_API)}/oauth2/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    scope: (o.scopes ?? DELEGATED_SCOPES).join(" "),
    state,
    code_challenge: base64url(challenge),
    code_challenge_method: "S256",
    resource: KEELSON_API,
  }).toString();
  return { url: url.href, codeVerifier, state };
}

/** Redeems the authorization code the redirect carried for tokens. */
export function exchangeCode(o: {
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}): Promise<TokenSet> {
  return tokenRequest(
    o.baseUrl ?? KEELSON_API,
    {
      grant_type: "authorization_code",
      client_id: o.clientId,
      code: o.code,
      code_verifier: o.codeVerifier,
      redirect_uri: o.redirectUri,
      resource: KEELSON_API,
    },
    {},
    o.fetch,
  );
}

/**
 * The tokens a user granted an app, refreshed with the refresh token as they expire. `onTokens`
 * receives every new set, so the app can store it. After the user stops every agent the refresh
 * token is revoked and `token()` rejects with `invalid_grant`: ask the user to sign in again.
 */
export function userTokens(o: {
  clientId: string;
  tokens: TokenSet;
  onTokens?: (tokens: TokenSet) => void | Promise<void>;
  baseUrl?: string;
  fetch?: typeof fetch;
}): TokenProvider {
  let tokens = o.tokens;
  let first = true;
  const provider = cached(async () => {
    if (first && Date.now() < tokens.expiresAt - EARLY_MS) {
      first = false;
      return tokens;
    }
    first = false;
    if (!tokens.refreshToken) throw new OAuthError(401, "invalid_grant", "no refresh token");
    const next = await tokenRequest(
      o.baseUrl ?? KEELSON_API,
      {
        grant_type: "refresh_token",
        client_id: o.clientId,
        refresh_token: tokens.refreshToken,
        resource: KEELSON_API,
      },
      {},
      o.fetch,
    );
    tokens = { ...next, refreshToken: next.refreshToken ?? tokens.refreshToken };
    await o.onTokens?.(tokens);
    return tokens;
  });
  return provider;
}

/** A token obtained elsewhere, sent as is. */
export function staticToken(token: string): TokenProvider {
  return { token: async () => token, invalidate() {} };
}
