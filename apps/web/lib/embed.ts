import type { PasskeyRef } from "@keelson/mandate/browser";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import { API } from "./config";
import type { ConnectionView } from "./connections";
import type { Compiled } from "./types";

/** The Keelson app, where a user without a passkey here signs in, top-level. */
export const APP_ORIGIN = process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://app.keelson.finance";

/** Who the frame signs for: the user's passkeys, and the one used in this frame. */
export interface EmbedSigner {
  passkeys: PasskeyRef[];
  credentialId: string | null;
}

/** An agent platform's embed of one request, as the embed session reads it. */
export interface EmbedView {
  ref: string;
  /** The platform's origin: the only frame ancestor, and the only `postMessage` peer. */
  origin: string;
  request: ConnectionView;
  /** Set once the user signed in here or linked a Keelson window. */
  signer: EmbedSigner | null;
  /** The number the Keelson window asks for before it signs there. */
  matchNumber: number | null;
}

/** What the embed tells its host. Never a token, a session or a signature. */
export type HostEvent =
  | { type: "ready"; requestId: string }
  | { type: "resize"; height: number }
  | { type: "approved"; requestId: string; mandateId: string }
  | { type: "declined"; requestId: string }
  | { type: "error"; code: string; message: string };

/** Every message carries this envelope, so a host tells Keelson's from its own. */
const SOURCE = "keelson";
const VERSION = 1;

/** The popup tells its opener, the frame on this same origin, that the user answered. */
export const DONE = "keelson:done";

/** The Keelson window hands its opener, the frame on the API's origin, the link's grant. */
export const LINKED = "keelson:linked";

/** Posts `event` to `peer`, delivered only if `peer` is at exactly `origin`. */
export function post(peer: Window | null, origin: string, event: HostEvent): void {
  peer?.postMessage({ source: SOURCE, version: VERSION, ...event }, origin);
}

export class EmbedError extends Error {
  override name = "EmbedError";
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Calls the API with the embed session, never with cookies. */
async function call<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, credentials: "omit", cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as T & { detail?: string; title?: string };
  if (!res.ok) throw new EmbedError(res.status, body.detail ?? body.title ?? `HTTP ${res.status}`);
  return body;
}

export const openEmbed = (token: string) =>
  call<{ session: string; embed: EmbedView }>("/v1/embed/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });

export const readEmbed = (session: string) =>
  call<EmbedView>("/v1/embed/request", { headers: { "keelson-embed": session } });

export const declineEmbed = (session: string) =>
  call<EmbedView>("/v1/embed/deny", {
    method: "POST",
    headers: { "keelson-embed": session, "idempotency-key": crypto.randomUUID() },
  });

const send = <T>(session: string, path: string, body?: unknown, headers?: HeadersInit) =>
  call<T>(path, {
    method: "POST",
    headers: {
      "keelson-embed": session,
      "idempotency-key": crypto.randomUUID(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

export const signInOptions = (session: string) =>
  send<PublicKeyCredentialRequestOptionsJSON>(session, "/v1/embed/sign-in/options");

export const signIn = (session: string, response: AuthenticationResponseJSON) =>
  send<EmbedSigner>(session, "/v1/embed/sign-in", response);

export const startLink = (session: string) =>
  send<{ nonce: string; expires_in: number }>(session, "/v1/embed/links");

export const claimLink = (session: string, grant: string) =>
  send<EmbedSigner>(session, "/v1/embed/links/claim", { grant });

export const passkeyOptions = (session: string, platform: boolean) =>
  send<PublicKeyCredentialCreationOptionsJSON>(session, "/v1/embed/passkeys/options", {
    platform,
  });

export const savePasskey = (session: string, response: RegistrationResponseJSON) =>
  send<EmbedSigner>(session, "/v1/embed/passkeys", response);

export const draftEmbed = (session: string, body: unknown, device: string) =>
  send<Compiled>(session, "/v1/embed/draft", body, { "keelson-device": device });

export const approveEmbed = (session: string, body: unknown) =>
  send<{ id: string; state: string }>(session, "/v1/embed/mandates", body);

/**
 * Whether this frame may ask for a passkey: the host delegated the feature and the browser lets a
 * cross-origin frame use it. Browsers without a policy API report nothing; the ceremony itself
 * then answers with `NotAllowedError` or `SecurityError`.
 */
export function framePasskeys(feature: "get" | "create"): boolean {
  if (typeof PublicKeyCredential === "undefined") return false;
  const doc = document as Document & {
    featurePolicy?: { allowsFeature(f: string): boolean };
    permissionsPolicy?: { allowsFeature(f: string): boolean };
  };
  const policy = doc.permissionsPolicy ?? doc.featurePolicy;
  return policy ? policy.allowsFeature(`publickey-credentials-${feature}`) : true;
}

/** The app page that signs the request, with the limits lowered here and the way back. */
export function signUrl(
  view: EmbedView,
  via: "frame" | "popup",
  chosen: {
    perPurchase: number;
    total: number;
    askAbove: number | null;
    merchants: string[];
    until: string;
  },
  link?: string,
): string {
  const url = new URL("/connect/", APP_ORIGIN);
  url.search = new URLSearchParams({
    c: view.request.code,
    embed: view.ref,
    via,
    ...(link ? { link } : {}),
    pp: String(chosen.perPurchase),
    tt: String(chosen.total),
    ...(chosen.askAbove === null ? {} : { aa: String(chosen.askAbove) }),
    m: chosen.merchants.join(","),
    u: chosen.until,
  }).toString();
  return url.toString();
}
