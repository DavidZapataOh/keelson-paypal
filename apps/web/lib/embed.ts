import { API } from "./config";
import type { ConnectionView } from "./connections";

/** Where the user signs: the app, top-level, the only origin a mandate's passkey assertion may name. */
const APP_ORIGIN = process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://app.keelson.finance";

/** An agent platform's embed of one request, as the embed session reads it. */
export interface EmbedView {
  ref: string;
  /** The platform's origin: the only frame ancestor, and the only `postMessage` peer. */
  origin: string;
  request: ConnectionView;
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
): string {
  const url = new URL("/connect/", APP_ORIGIN);
  url.search = new URLSearchParams({
    c: view.request.code,
    embed: view.ref,
    via,
    pp: String(chosen.perPurchase),
    tt: String(chosen.total),
    ...(chosen.askAbove === null ? {} : { aa: String(chosen.askAbove) }),
    m: chosen.merchants.join(","),
    u: chosen.until,
  }).toString();
  return url.toString();
}
