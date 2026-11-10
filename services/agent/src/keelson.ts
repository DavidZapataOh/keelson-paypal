import type { Keelson } from "./checkout.ts";

/** RFC 8707 resource of Keelson's API: the audience of every access token it accepts. */
const AUDIENCE = "https://api.keelson.finance";
/** Refresh this long before the token expires. */
const EARLY_MS = 60_000;

export interface ApiClientOptions {
  /** Keelson's API origin, `https://api.keelson.finance`. */
  apiUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: readonly string[];
}

/**
 * Keelson's API over HTTPS as an OAuth client: an access token from the client credentials
 * grant (RFC 6749 §4.4) for Keelson's audience, kept until a minute before it expires.
 */
export function apiClient(o: ApiClientOptions): Keelson {
  let token: { value: string; until: number } | undefined;
  const bearer = async () => {
    if (token && Date.now() < token.until) return token.value;
    const res = await fetch(new URL("/api/auth/oauth2/token", o.apiUrl), {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${encodeURIComponent(o.clientId)}:${encodeURIComponent(o.clientSecret)}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: o.scopes.join(" "),
        resource: AUDIENCE,
      }),
    });
    if (!res.ok) throw new Error(`no access token: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    token = { value: body.access_token, until: Date.now() + body.expires_in * 1000 - EARLY_MS };
    return token.value;
  };
  return {
    async request(path, init) {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${await bearer()}`);
      return fetch(new URL(path, o.apiUrl), { ...init, headers });
    },
  };
}

/** The agent's P-256 `cnf` key from its private JWK (`KEELSON_AGENT_KEY`). */
export async function agentKey(privateJwk: string): Promise<{
  privateKey: CryptoKey;
  publicJwk: { kty: "EC"; crv: "P-256"; x: string; y: string };
}> {
  const jwk = JSON.parse(privateJwk) as JsonWebKey;
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.d || !jwk.x || !jwk.y) {
    throw new Error("the agent key is not a private P-256 JWK");
  }
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  return { privateKey, publicJwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } };
}
