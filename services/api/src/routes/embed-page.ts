import { createHash } from "node:crypto";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import type { Deps } from "../app.ts";
import { readEmbed } from "../embed.ts";

/** Every response that names no ancestors of its own may not be framed (CSP3 `frame-ancestors`). */
export const noFraming: MiddlewareHandler = async (c, next) => {
  await next();
  if (c.res.headers.has("content-security-policy")) return;
  // A response passed through from fetch has immutable headers.
  const res = new Response(c.res.body, c.res);
  res.headers.set("content-security-policy", "frame-ancestors 'none'");
  res.headers.set("x-frame-options", "DENY");
  c.res = res;
};

/**
 * The CSP hash source (`'sha256-…'`) of every inline `<script>` in `html`, over its exact text.
 * The markup is the app's own static export, so a script element is found by its tags.
 * @internal
 */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  let at = html.indexOf("<script");
  while (at !== -1) {
    const open = html.indexOf(">", at);
    const close = html.indexOf("</script>", open);
    if (open === -1 || close === -1) break;
    if (!/\ssrc=/.test(html.slice(at, open))) {
      const text = html.slice(open + 1, close);
      hashes.push(`'sha256-${createHash("sha256").update(text).digest("base64")}'`);
    }
    at = html.indexOf("<script", close);
  }
  return hashes;
}

/**
 * The embed page's policy. Its HTML and scripts are the app's static export, loaded from the
 * app's origin; it calls only this API. The mandate's Poseidon2 commitment runs in a worker.
 * @internal
 */
export function embedPolicy(
  appOrigin: string,
  ancestor: string | undefined,
  scriptHashes: string[],
): string {
  return [
    "default-src 'none'",
    // A static export has no per-request nonce: its inline scripts are allowed by hash, and its
    // chunks, which carry no nonce or integrity for 'strict-dynamic' to trust, by origin.
    ["script-src", ...scriptHashes, "'wasm-unsafe-eval'", appOrigin].join(" "),
    `worker-src blob: ${appOrigin}`,
    `style-src 'unsafe-inline' ${appOrigin}`,
    `font-src ${appOrigin}`,
    `img-src data: ${appOrigin}`,
    `connect-src 'self' data: ${appOrigin}`,
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'none'",
    `frame-ancestors ${ancestor ?? "'none'"}`,
  ].join("; ");
}

/**
 * The passkey and payment features are this page's alone, and only where the host delegates them
 * with the frame's `allow`; nothing the page loads gets them.
 */
const PERMISSIONS =
  "publickey-credentials-get=(self), publickey-credentials-create=(self), payment=(self), camera=(), microphone=(), geolocation=(), clipboard-read=()";

/**
 * `GET /embed/approve?r=<ref>`: the approval an agent platform frames. Only the origin the
 * request's embed was minted for may frame it (`frame-ancestors`, per request); an unknown or
 * lapsed ref may be framed by no one. `html` returns the page's markup.
 */
export function registerEmbedPage(
  app: OpenAPIHono,
  deps: Pick<Deps, "kv" | "appOrigin">,
  html: () => Promise<string>,
): void {
  const appOrigin = deps.appOrigin ?? "https://app.keelson.finance";
  app.get("/embed/approve", async (c) => {
    const ref = c.req.query("r") ?? "";
    const embed = await readEmbed(deps.kv, ref);
    let page: string;
    try {
      page = await html();
    } catch {
      return c.text("The approval page is unavailable. Try again in a moment.", 503, {
        "content-security-policy": "frame-ancestors 'none'",
        "cache-control": "no-store",
      });
    }
    return c.html(page, 200, {
      "content-security-policy": embedPolicy(appOrigin, embed?.origin, inlineScriptHashes(page)),
      "permissions-policy": PERMISSIONS,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    });
  });
}

/**
 * The app's exported `/embed/approve/` markup, fetched from `appOrigin` and kept for 30 seconds,
 * so a new app deploy reaches the page within that.
 */
export function appEmbedPage(appOrigin: string, ttlMs = 30_000): () => Promise<string> {
  let cached: { html: string; at: number } | undefined;
  let pending: Promise<string> | undefined;
  return async () => {
    if (cached && Date.now() - cached.at < ttlMs) return cached.html;
    pending ??= (async () => {
      try {
        const res = await fetch(new URL("/embed/approve/", appOrigin), {
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) throw new Error(`the app answered ${res.status}`);
        const html = await res.text();
        cached = { html, at: Date.now() };
        return html;
      } catch (err) {
        if (cached) return cached.html;
        throw err;
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  };
}
