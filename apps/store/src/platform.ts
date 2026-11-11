import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import { html, raw } from "hono/html";
import { NONCE, type SecureHeadersVariables, secureHeaders } from "hono/secure-headers";
import type { Logger } from "pino";
import type { RedisClientType } from "redis";

/**
 * A minimal agent platform that embeds Keelson's approval: its backend asks Keelson for a mandate
 * as an OAuth client (`POST /v1/connections`), mints embed URLs for this page's origin, and polls
 * for the answer (RFC 8628) like any platform would. It runs on its own site, so the frame is
 * third-party to it.
 */
export interface PlatformDeps {
  /** Keelson's API, `https://api.keelson.finance`. */
  api: string;
  /** Where the embed SDK is served, `https://app.keelson.finance`. */
  app: string;
  /** This page's public origin, registered as the client's embed origin. */
  origin: string;
  clientId: string;
  clientSecret: string;
  kv: RedisClientType;
  log: Logger;
}

const TTL_SEC = 1_800;
const DAY_MS = 86_400_000;
const REASON =
  "I am the shopping agent on this demo platform. You asked me to find and buy running shoes under $120 at RunFast; I compare the pairs, then check out only what you approve here.";

interface Stored {
  deviceCode: string;
  interval: number;
  mandateId?: string;
  /** The last answer and when it was read: Keelson is polled at most once per `interval`. */
  status?: string;
  polledAt?: number;
}

export function registerPlatform(
  app: Hono<{ Variables: SecureHeadersVariables }>,
  deps: PlatformDeps,
): void {
  let token: { value: string; until: number } | undefined;
  let originsSet = false;

  const bearer = async () => {
    if (token && Date.now() < token.until) return token.value;
    const res = await fetch(new URL("/api/auth/oauth2/token", deps.api), {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${encodeURIComponent(deps.clientId)}:${encodeURIComponent(deps.clientSecret)}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "countersign:write",
        resource: deps.api,
      }),
    });
    if (!res.ok) throw new Error(`no access token: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    token = { value: body.access_token, until: Date.now() + (body.expires_in - 60) * 1000 };
    return token.value;
  };
  const keelson = async (path: string, init: RequestInit & { idempotent?: boolean } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${await bearer()}`);
    if (init.method === "POST" && init.idempotent !== false) {
      headers.set("idempotency-key", randomUUID());
    }
    return fetch(new URL(path, deps.api), { ...init, headers });
  };
  const json = (body: unknown) => ({
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const embedUrl = async (deviceCode: string) => {
    const res = await keelson("/v1/connections/embed", {
      method: "POST",
      ...json({ device_code: deviceCode, origin: deps.origin }),
    });
    if (!res.ok) throw new Error(`embed: HTTP ${res.status}`);
    return ((await res.json()) as { url: string }).url;
  };
  const key = (id: string) => `platform:req:${id}`;

  const page = secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: [NONCE, deps.app],
      styleSrc: ["'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      frameSrc: [deps.api],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
      frameAncestors: ["'none'"],
    },
    // The Keelson window answers this page through its opener.
    crossOriginOpenerPolicy: "same-origin-allow-popups",
    // The user signs in Keelson's frame: its passkey and payment prompts are delegated to it. A
    // frame gets a feature only where its parent has it too, so this page keeps them as well.
    permissionsPolicy: {
      publickeyCredentialsGet: ["self", deps.api],
      payment: ["self", deps.api],
      ...({ publickeyCredentialsCreate: ["self", deps.api] } as object),
    },
  });

  // The page is served only on the origin registered with Keelson; the frame refuses any other.
  const onOrigin = async (c: Context, next: () => Promise<void>) => {
    const here = `https://${c.req.header("host")}`;
    if (here !== deps.origin && process.env.NODE_ENV === "production") {
      return c.redirect(`${deps.origin}${c.req.path}`, 308);
    }
    await next();
  };

  app.get("/platform", onOrigin, page, (c) =>
    c.html(platformPage(c.get("secureHeadersNonce") as string, deps.app)),
  );

  app.post("/platform/requests", onOrigin, async (c) => {
    // Only this page may ask, never a cross-site form or fetch.
    if (c.req.header("sec-fetch-site") !== "same-origin") {
      return c.json({ error: "Ask from the platform page." }, 403);
    }
    // Render's edge sets the client address; a client-sent X-Forwarded-For entry is never read.
    const ip =
      c.req.header("cf-connecting-ip") ??
      c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
    const slot = Math.floor(Date.now() / 600_000);
    const [mine, all] = (await deps.kv
      .multi()
      .incr(`platform:rl:${ip ?? "unknown"}:${slot}`)
      .expire(`platform:rl:${ip ?? "unknown"}:${slot}`, 600)
      .incr(`platform:rl:all:${slot}`)
      .expire(`platform:rl:all:${slot}`, 600)
      .exec()) as unknown as [number, number, number, number];
    if (mine > 10 || all > 120) {
      return c.json({ error: "Too many requests; try again in a few minutes." }, 429);
    }
    try {
      if (!originsSet) {
        const res = await keelson("/v1/embed/origins", {
          method: "PUT",
          ...json({ origins: [deps.origin] }),
        });
        if (!res.ok) throw new Error(`embed origins: HTTP ${res.status}`);
        originsSet = true;
      }
      const res = await keelson("/v1/connections", {
        method: "POST",
        ...json({
          name: "Shopping agent",
          reason: REASON,
          limits: {
            currency: "USD",
            perPurchaseMinor: 6_000,
            totalMinor: 12_000,
            askAboveMinor: 4_000,
            merchants: ["mrc_runfast"],
            until: new Date(Date.now() + 7 * DAY_MS).toISOString(),
          },
        }),
      });
      if (!res.ok) throw new Error(`connections: HTTP ${res.status}`);
      const device = (await res.json()) as { device_code: string; interval: number };
      // Two single-use URLs: one to frame, one for the Keelson window should framing fail.
      const [frame, popup] = await Promise.all([
        embedUrl(device.device_code),
        embedUrl(device.device_code),
      ]);
      const id = randomUUID();
      await deps.kv.set(
        key(id),
        JSON.stringify({
          deviceCode: device.device_code,
          interval: device.interval,
        } satisfies Stored),
        { EX: TTL_SEC },
      );
      return c.json({ id, frame, popup }, 201, { "cache-control": "no-store" });
    } catch (err) {
      deps.log.warn({ err }, "platform request failed");
      return c.json({ error: "Keelson did not take the request. Try again." }, 502);
    }
  });

  // What this platform's backend knows: the answer comes from Keelson, never from the page.
  app.get("/platform/requests/:id", onOrigin, async (c) => {
    const id = c.req.param("id") ?? "";
    const saved = await deps.kv.get(key(id));
    if (!saved) return c.json({ status: "unknown" }, 404);
    const stored = JSON.parse(saved) as Stored;
    if (stored.mandateId) return c.json({ status: "approved", mandateId: stored.mandateId });
    if (stored.status && stored.polledAt && Date.now() - stored.polledAt < stored.interval * 1000) {
      return c.json({ status: stored.status }, 200, { "cache-control": "no-store" });
    }
    const res = await keelson("/v1/connections/token", {
      method: "POST",
      idempotent: false,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: stored.deviceCode,
      }),
    });
    const body = (await res.json()) as { mandate_id?: string; error?: string };
    if (res.ok && body.mandate_id) {
      await deps.kv.set(key(id), JSON.stringify({ ...stored, mandateId: body.mandate_id }), {
        KEEPTTL: true,
      });
      return c.json({ status: "approved", mandateId: body.mandate_id });
    }
    const status =
      body.error === "access_denied"
        ? "declined"
        : body.error === "expired_token"
          ? "expired"
          : "pending";
    await deps.kv.set(key(id), JSON.stringify({ ...stored, status, polledAt: Date.now() }), {
      KEEPTTL: true,
    });
    return c.json({ status }, 200, { "cache-control": "no-store" });
  });
}

function platformPage(nonce: string, keelsonApp: string) {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Agent platform demo</title>
    <style>
      :root { color-scheme: light; font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; color: #1b1d22; background: #eef0f3; }
      body { margin: 0; }
      header { display: flex; align-items: center; gap: 10px; padding: 14px 24px; background: #fff; border-bottom: 1px solid #dde1e7; }
      header b { font-size: 16px; }
      header span { color: #5b6270; font-size: 13px; }
      main { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 24px; max-width: 1080px; margin: 24px auto; padding: 0 24px; }
      @media (max-width: 860px) { main { grid-template-columns: 1fr; } }
      .chat { display: grid; gap: 14px; align-content: start; }
      .msg { max-width: 560px; padding: 12px 14px; border-radius: 14px; background: #fff; box-shadow: 0 1px 2px rgb(0 0 0 / .06); }
      .msg.user { justify-self: end; background: #2b5cff; color: #fff; }
      .who { font-size: 12px; color: #5b6270; margin-bottom: 2px; }
      .slot { max-width: 460px; border-radius: 16px; overflow: hidden; background: #fff; box-shadow: 0 8px 30px -12px rgb(0 0 0 / .25); }
      button { font: inherit; padding: 10px 16px; border-radius: 10px; border: 1px solid #c9ced8; background: #fff; cursor: pointer; }
      button.primary { background: #1b1d22; color: #fff; border-color: #1b1d22; }
      button:disabled { opacity: .5; cursor: default; }
      .row { display: flex; gap: 8px; flex-wrap: wrap; }
      aside { display: grid; gap: 12px; align-content: start; }
      .panel { background: #fff; border-radius: 12px; padding: 14px; box-shadow: 0 1px 2px rgb(0 0 0 / .06); }
      .panel h2 { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #5b6270; }
      ol { margin: 0; padding-left: 18px; font: 12px/1.6 ui-monospace, monospace; word-break: break-all; }
      #backend { font: 13px/1.5 ui-monospace, monospace; }
    </style>
  </head>
  <body>
    <header><b>Agent platform demo</b><span>An agent's app that embeds Keelson's approval</span></header>
    <main>
      <section class="chat" aria-label="Conversation">
        <div class="msg user"><div class="who">You</div>Find me running shoes under $120 at RunFast and buy the best pair.</div>
        <div class="msg"><div class="who">Shopping agent</div>I can do that. First I need your permission to spend, up to $120 at RunFast for the next 7 days.
          <div class="row" style="margin-top:10px">
            <button class="primary" id="ask">Ask for approval</button>
            <button id="window" disabled>Use a Keelson window instead</button>
          </div>
        </div>
        <div class="slot" id="slot" hidden></div>
        <div class="msg" id="after" hidden><div class="who">Shopping agent</div><span id="after-text"></span></div>
      </section>
      <aside>
        <div class="panel"><h2>Backend (RFC 8628 poll)</h2><div id="backend">No request yet.</div></div>
        <div class="panel"><h2>Events from Keelson</h2><ol id="events"></ol></div>
      </aside>
    </main>
    <script src="${keelsonApp}/embed/v1.js" nonce="${nonce}"></script>
    <script nonce="${nonce}">${raw(PAGE_SCRIPT)}</script>
  </body>
</html>`;
}

const PAGE_SCRIPT = `
const $ = (id) => document.getElementById(id);
let current, mounted, polling;
const log = (e) => {
  const li = document.createElement("li");
  li.textContent = JSON.stringify(e);
  $("events").append(li);
};
const say = (text) => { $("after").hidden = false; $("after-text").textContent = text; };
const onEvent = (e) => {
  log(e);
  if (e.type === "approved") say("Thanks. I'm allowed now, and Keelson checks every purchase against what you approved.");
  if (e.type === "declined") say("Understood. I won't buy anything.");
  if (e.type === "error" && e.code === "frame-timeout") $("window").disabled = false;
};
async function poll() {
  const res = await fetch("/platform/requests/" + current.id, { cache: "no-store" });
  const body = await res.json();
  $("backend").textContent =
    body.status === "approved" ? "Mandate " + body.mandateId + " is live for this agent." : "Status: " + body.status;
  if (body.status === "pending") polling = setTimeout(poll, 5000);
}
$("ask").addEventListener("click", async () => {
  $("ask").disabled = true;
  $("backend").textContent = "Creating the request...";
  const res = await fetch("/platform/requests", { method: "POST" });
  const body = await res.json();
  if (!res.ok) { $("backend").textContent = body.error; $("ask").disabled = false; return; }
  current = body;
  $("window").disabled = false;
  $("slot").hidden = false;
  mounted = Keelson.mount($("slot"), { url: body.frame, onEvent });
  poll();
});
$("window").addEventListener("click", () => {
  if (!current) return;
  mounted?.destroy();
  $("slot").hidden = true;
  $("window").disabled = true;
  Keelson.popup({ url: current.popup, onEvent });
});
`;
