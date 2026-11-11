import { errorFor } from "./errors.ts";
import type { AuthProvider } from "./transport.ts";

/** RFC 8707 resource of Keelson's API: the audience of every token it accepts. */
export const AUDIENCE = "https://api.keelson.finance";
export const DEFAULT_BASE_URL = "https://api.keelson.finance";
/** Scopes an operator's agent asks for with client credentials. */
export const OPERATOR_SCOPES: readonly string[] = [
  "countersign:write",
  "evidence:write",
  "alibis:read",
];

/** Asks the token endpoint and turns an OAuth error into a typed one. */
export async function tokenRequest(
  baseUrl: string,
  form: Record<string, string>,
  headers: Record<string, string> = {},
  fetcher: typeof fetch = fetch,
): Promise<{
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}> {
  const res = await fetcher(new URL("/api/auth/oauth2/token", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ resource: AUDIENCE, ...form }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw errorFor(res.status, body, res.headers.get("x-request-id"));
  return body as { access_token: string; expires_in: number };
}

/**
 * An operator's agent, with its OAuth client (RFC 6749 §4.4). The token is kept until 30 s before
 * it expires.
 */
export function clientCredentials(o: {
  clientId: string;
  clientSecret: string;
  scopes?: readonly string[];
  baseUrl?: string;
}): AuthProvider {
  let cached: { value: string; until: number } | undefined;
  const basic = btoa(`${encodeURIComponent(o.clientId)}:${encodeURIComponent(o.clientSecret)}`);
  return {
    async token({ force = false } = {}) {
      if (cached && !force && Date.now() < cached.until) return cached.value;
      const t = await tokenRequest(
        o.baseUrl ?? DEFAULT_BASE_URL,
        { grant_type: "client_credentials", scope: (o.scopes ?? OPERATOR_SCOPES).join(" ") },
        { authorization: `Basic ${basic}` },
      );
      cached = { value: t.access_token, until: Date.now() + (t.expires_in - 30) * 1000 };
      return cached.value;
    },
  };
}

/** A token you already hold. */
export function staticToken(token: string): AuthProvider {
  return { token: async () => token };
}
