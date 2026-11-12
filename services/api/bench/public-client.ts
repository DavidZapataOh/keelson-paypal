/**
 * Keelson's public API from a bench: a signed-in user's requests (session cookie), an agent's
 * (OAuth access token), and the user's mandates held with their saved PayPal. Nothing here reads
 * Keelson's database.
 */
import type { Mandate } from "@keelson/mandate";
import { ulid } from "ulid";
import type { Passkey } from "../test/tee-live.ts";

/** The shape of an in-process app's `request`, so code written for one also runs over HTTP. */
export interface Api {
  request(path: string | URL | Request, init?: RequestInit): Promise<Response>;
}

/** Requests to `base`, each with the headers `auth` gives (none by default). */
export function remote(
  base: string,
  auth: () => Promise<Record<string, string>> | Record<string, string> = () => ({}),
): Api {
  return {
    async request(path, init = {}) {
      const headers = new Headers(init.headers);
      for (const [k, v] of Object.entries(await auth())) headers.set(k, v);
      return fetch(new URL(path instanceof Request ? path.url : path, base), { ...init, headers });
    },
  };
}

/** The cookies a response sets, as one `Cookie` header value joined to `jar`. */
function cookies(res: Response, jar = ""): string {
  const set = res.headers.getSetCookie().map((c) => c.split(";")[0] as string);
  return [...jar.split("; ").filter(Boolean), ...set].join("; ");
}

export interface UserSession {
  sub: string;
  /** The user's requests, with the session cookie and the app's origin. */
  api: Api;
  /** A POST with JSON and a fresh Idempotency-Key. */
  post(path: string, body?: unknown): Promise<{ status: number; out: Record<string, unknown> }>;
}

/**
 * Signs in with `passkey` (WebAuthn assertion through Better Auth's passkey endpoints) as the
 * app at `origin` does.
 */
export async function signIn(api: string, passkey: Passkey, origin: string): Promise<UserSession> {
  const options = await fetch(new URL("/api/auth/passkey/generate-authenticate-options", api), {
    headers: { origin },
  });
  if (!options.ok) throw new Error(`no passkey options: ${options.status}`);
  let jar = cookies(options);
  const { challenge } = (await options.json()) as { challenge: string };
  const assertion = await passkey.assert(Buffer.from(challenge, "base64url"));
  const verified = await fetch(new URL("/api/auth/passkey/verify-authentication", api), {
    method: "POST",
    headers: { "content-type": "application/json", origin, cookie: jar },
    body: JSON.stringify({
      response: {
        id: passkey.credentialId,
        rawId: passkey.credentialId,
        type: "public-key",
        response: assertion,
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
      },
    }),
  });
  if (!verified.ok)
    throw new Error(`passkey sign-in refused: ${verified.status} ${await verified.text()}`);
  jar = cookies(verified, jar);
  const user = remote(api, () => ({ cookie: jar, origin }));
  const session = (await (await user.request("/api/auth/get-session")).json()) as {
    user?: { id: string };
  } | null;
  if (!session?.user) throw new Error("signed in, but the API has no session");
  return {
    sub: session.user.id,
    api: user,
    async post(path, body) {
      const res = await user.request(path, {
        method: "POST",
        headers: {
          "idempotency-key": ulid(),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, out: (await res.json()) as Record<string, unknown> };
    },
  };
}

export interface Hold {
  sub: string;
  mid: string;
  openMandate: string;
  key: CryptoKey;
  authorizationId: string;
}

/** A signed mandate's `POST /v1/mandates` body and the agent key it names. */
export type SignMandate = (
  sub: string,
  edit: (m: Mandate) => void,
) => Promise<{ body: unknown; key: CryptoKey }>;

/**
 * A new mandate of the user's, after `edit`, held with their saved PayPal: no PayPal window, so
 * it fails if PayPal still asks the buyer.
 */
export async function openHold(
  user: UserSession,
  sign: SignMandate,
  edit: (m: Mandate) => void,
): Promise<Hold> {
  const signed = await sign(user.sub, (m) => {
    m.mid = ulid();
    edit(m);
  });
  const stored = await user.post("/v1/mandates", signed.body);
  if (stored.status !== 201) throw new Error(`mandate not stored: ${JSON.stringify(stored.out)}`);
  const mid = stored.out.id as string;
  const held = await user.post(`/v1/mandates/${mid}/hold`);
  if (held.status !== 200 || held.out.approved !== true) {
    throw new Error(`the saved PayPal did not hold ${mid}: ${JSON.stringify(held.out)}`);
  }
  const authorized = await user.post(`/v1/mandates/${mid}/hold/authorize`, {
    orderId: held.out.orderId,
  });
  if (authorized.status !== 200) {
    throw new Error(`hold not authorized: ${JSON.stringify(authorized.out)}`);
  }
  return {
    sub: user.sub,
    mid,
    openMandate: stored.out.openMandate as string,
    key: signed.key,
    authorizationId: authorized.out.authorizationId as string,
  };
}

/** What is left of a mandate's budget, as `remaining/max` in minor units. */
export async function remaining(user: UserSession, mid: string): Promise<string> {
  const m = (await (await user.api.request(`/v1/mandates/${mid}`)).json()) as {
    budget?: { remainingMinor: string; maxMinor: string };
  };
  return `${m.budget?.remainingMinor}/${m.budget?.maxMinor}`;
}

/** The events, and the states, after which a purchase has nothing left to do. */
const ENDED_EVENTS = new Set(["purchase.captured", "purchase.failed", "purchase.capture_denied"]);
const DRIVEN = new Set(["COUNTERSIGNED", "LOGGED", "COVERED"]);

/**
 * Watches purchase `purchaseId` until it ends, at most `timeoutMs`: on the agent's event stream
 * `channel`, and by reading `GET /v1/purchases/{id}` every `pollMs`, whichever says so first.
 * Open it before the countersign: `ready` resolves once the stream is open. `ended` resolves with
 * the event type or the state that ended it, or `undefined` when the time ran out.
 */
export function watchPurchase(
  agent: Api,
  channel: string,
  purchaseId: string,
  timeoutMs: number,
  pollMs = 1_000,
): { ready: Promise<void>; ended: Promise<string | undefined> } {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let open!: () => void;
  const ready = new Promise<void>((r) => {
    open = r;
  });
  const stream = (async () => {
    try {
      const res = await agent.request(`/v1/events?channel=${encodeURIComponent(channel)}`, {
        headers: { accept: "text/event-stream" },
        signal: abort.signal,
      });
      open();
      if (!res.ok || !res.body) return new Promise<undefined>(() => {});
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const data = buffer
            .slice(0, end)
            .split("\n")
            .find((l) => l.startsWith("data:"));
          buffer = buffer.slice(end + 2);
          const type = data ? (JSON.parse(data.slice(5)) as { type?: string }).type : undefined;
          if (type && ENDED_EVENTS.has(type)) return type;
        }
      }
      return new Promise<undefined>(() => {});
    } catch {
      open();
      return new Promise<undefined>(() => {});
    }
  })();
  // Reading the purchase does not depend on any one event arriving, and costs one request a pollMs.
  const polled = (async () => {
    await ready;
    while (!abort.signal.aborted) {
      await new Promise((r) => setTimeout(r, pollMs));
      const res = await agent
        .request(`/v1/purchases/${purchaseId}`, { signal: abort.signal })
        .catch(() => undefined);
      if (res?.ok) {
        const { state } = (await res.json()) as { state: string };
        if (!DRIVEN.has(state)) return state;
      }
    }
    return undefined;
  })();
  const timedOut = new Promise<undefined>((r) =>
    abort.signal.addEventListener("abort", () => r(undefined)),
  );
  const ended = Promise.race([stream, polled, timedOut]).finally(() => {
    clearTimeout(timer);
    abort.abort();
  });
  return { ready, ended };
}

/** Revokes a mandate; one that already ended (spent or expired) has nothing left to release. */
export async function revokeMandate(user: UserSession, mid: string): Promise<void> {
  const { status, out } = await user.post(`/v1/mandates/${mid}/revoke`);
  if (status < 300) return;
  if (status === 409 && String(out.type).endsWith("/mandate-ended")) return;
  throw new Error(`mandate ${mid} not revoked: ${status} ${JSON.stringify(out)}`);
}

/**
 * Waits until mandate `mid`'s C3 proof is published, reading `GET /v1/mandates/{id}` every
 * `pollMs`, at most `timeoutMs`. Returns how long it took from `signedAt` (epoch ms).
 */
export async function waitC3Published(
  user: UserSession,
  mid: string,
  signedAt: number,
  timeoutMs: number,
  pollMs = 1_000,
): Promise<number> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const m = (await (await user.api.request(`/v1/mandates/${mid}`)).json()) as {
      c3Published?: boolean;
    };
    if (m.c3Published) return Date.now() - signedAt;
    if (Date.now() > until) throw new Error(`mandate ${mid}'s C3 not published in ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
