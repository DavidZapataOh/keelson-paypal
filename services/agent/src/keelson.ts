import type { AmountCheck } from "@keelson/mandate";
import type { Keelson } from "./checkout.ts";
import type { Authority } from "./gate.ts";

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
 * An access token for Keelson's audience from the client credentials grant (RFC 6749 §4.4), kept
 * until a minute before it expires.
 */
export function accessToken(o: ApiClientOptions): () => Promise<string> {
  let token: { value: string; until: number } | undefined;
  return async () => {
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
}

/** Keelson's API over HTTPS as an OAuth client, with a token from {@link accessToken}. */
export function apiClient(o: ApiClientOptions): Keelson {
  const bearer = accessToken(o);
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

/** An active mandate naming the agent's operator, as `GET /v1/operators/{agentId}/mandates` lists it. */
export interface OperatorMandate {
  id: string;
  currency: string;
  remainingMinor: number;
  expiresAt: string;
  holdMode: "mandate" | "per_purchase" | null;
  authorizationId: string | null;
  openMandate: string;
}

/** The active mandates the operator's agent may buy under, newest first. */
export async function operatorMandates(
  keelson: Keelson,
  agentId: bigint,
): Promise<OperatorMandate[]> {
  const res = await keelson.request(`/v1/operators/${agentId}/mandates`, { method: "GET" });
  if (!res.ok) throw new Error(`mandates not read: HTTP ${res.status}`);
  return ((await res.json()) as { mandates: OperatorMandate[] }).mandates;
}

/** Tells the mandate's owner the agent started or ended a run, with its read-only live view. */
export async function announceRun(
  keelson: Keelson,
  agentId: bigint,
  mandateId: string,
  state: "started" | "ended",
  liveViewUrl?: string,
): Promise<void> {
  const res = await keelson.request(`/v1/operators/${agentId}/mandates/${mandateId}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ state, ...(liveViewUrl ? { liveViewUrl } : {}) }),
  });
  if (res.status !== 202) throw new Error(`run not announced: HTTP ${res.status}`);
}

/** Why Keelson's amount check holds the payment, by its problem type. */
const HELD: Readonly<Record<string, string>> = {
  "amount-declined":
    "You declined this amount on your phone. Do not pay: call finish with blocked.",
  "amount-confirmation-expired":
    "You did not confirm this amount in time. Do not pay: call finish with blocked.",
  "amount-order-changed":
    "PayPal's checkout shows a different order than PayPal's API returned. Paying waits.",
};

/**
 * The pay-click gate's {@link Authority}: `POST /v1/purchases/{id}/amount-check` for the purchase
 * `purchase()` names, the countersign's or the last re-quote's.
 */
export function amountAuthority(keelson: Keelson, purchase: () => string): Authority {
  return async (orderId, crossCheck, order) => {
    const res = await keelson.request(`/v1/purchases/${purchase()}/amount-check`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ orderId, crossCheck, ...(order ? { order } : {}) }),
    });
    if (res.status === 200) return { check: (await res.json()) as AmountCheck };
    if (res.status === 202) return { needs: "user_confirmed" };
    const p = (await res.json().catch(() => ({}))) as { type?: string; field?: string };
    const type = p.type?.split("/").pop() ?? "";
    if (type === "amount-mismatch") {
      return {
        refused: `PayPal's order does not match what Keelson countersigned (${p.field ?? "order"}). Paying waits.`,
      };
    }
    return {
      refused:
        HELD[type] ?? `Keelson could not decide this amount (HTTP ${res.status}). Paying waits.`,
    };
  };
}
