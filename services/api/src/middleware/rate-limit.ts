import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import type { RedisClientType } from "redis";
import { problem } from "../problem.ts";

export interface RateLimitOptions {
  /** Requests per window for an authenticated principal. */
  limit?: number;
  /** Requests per window for an anonymous caller, keyed by client IP. */
  anonymousLimit?: number;
  windowSec?: number;
  /**
   * Behind Render, which sits behind Cloudflare: read the client IP from `CF-Connecting-IP`, which
   * Cloudflare overwrites; else the third-from-right `X-Forwarded-For` entry (`<client>, <edge>,
   * <render>`); else the socket address. Left-hand entries and `True-Client-IP` are never used.
   */
  trustProxy?: boolean;
}

function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const cf = c.req.header("cf-connecting-ip")?.trim();
    if (cf) return cf;
    const hops = c.req.header("x-forwarded-for")?.split(",");
    const appended = hops !== undefined && hops.length >= 3 ? hops[hops.length - 3]?.trim() : "";
    if (appended) return appended;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Fixed-window limiter (INCR + EXPIRE NX in one MULTI) that advertises its quota with the
 * `RateLimit-Policy` and `RateLimit` fields of draft-ietf-httpapi-ratelimit-headers-11.
 * It fails open when the store is unreachable; the idempotency middleware guards writes.
 */
export function rateLimit(kv: RedisClientType, options: RateLimitOptions = {}): MiddlewareHandler {
  const { limit = 600, anonymousLimit = 120, windowSec = 60, trustProxy = false } = options;
  return async (c, next) => {
    const principal = c.get("principal");
    const owner =
      principal === undefined
        ? `ip:${clientIp(c, trustProxy)}`
        : Buffer.from(`${principal.kind}:${principal.subject}`).toString("base64url");
    const quota = principal === undefined ? anonymousLimit : limit;
    const nowSec = Math.floor(Date.now() / 1000);
    const window = Math.floor(nowSec / windowSec);
    const reset = (window + 1) * windowSec - nowSec;

    let count: number;
    try {
      const [incr] = await kv
        .multi()
        .incr(`rl:${owner}:${window}`)
        .expire(`rl:${owner}:${window}`, windowSec, "NX")
        .exec();
      count = Number(incr);
      if (!Number.isFinite(count)) return next();
    } catch {
      return next();
    }

    const remaining = Math.max(quota - count, 0);
    c.header("RateLimit-Policy", `"default";q=${quota};w=${windowSec}`);
    c.header("RateLimit", `"default";r=${remaining};t=${reset}`);
    if (count > quota) {
      c.header("Retry-After", String(reset));
      return problem(c, 429, "rate-limited", "Too many requests", `Retry after ${reset} seconds.`);
    }
    await next();
  };
}
