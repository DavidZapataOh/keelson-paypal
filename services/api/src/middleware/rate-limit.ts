import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import type { RedisClientType } from "redis";
import { principalKey } from "../principal.ts";
import { problem } from "../problem.ts";

export interface RateLimitOptions {
  /** The policy name; limiters with different names count separately. */
  name?: string;
  /** Answer 503 instead of letting requests through when the store is unreachable. */
  failClosed?: boolean;
  /** Requests per window for an authenticated principal. */
  limit?: number;
  /** Requests per window for an anonymous caller, keyed by client IP. */
  anonymousLimit?: number;
  windowSec?: number;
  /**
   * Behind Render, which sits behind Cloudflare: read the client IP from `CF-Connecting-IP`, which
   * Cloudflare always sets and refuses when a caller sends a value (error 1000); else the
   * third-from-right `X-Forwarded-For` entry (`<client>, <edge>, <render>`); else the socket
   * address. Left-hand entries and `True-Client-IP` are never used.
   */
  trustProxy?: boolean;
}

/** The caller's IP address, read as {@link RateLimitOptions.trustProxy} describes, if known. */
export function clientAddress(c: Context, trustProxy: boolean): string | undefined {
  const address = rawAddress(c, trustProxy);
  const mapped = address && /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) return mapped[1];
  return address?.includes(":") ? ipv6Prefix(address) : address;
}

/** One IPv6 host usually holds a whole /64, so it is counted as one caller. */
function ipv6Prefix(address: string): string {
  const [head = "", tail = ""] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = address.includes("::")
    ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
    : left;
  return `${groups.slice(0, 4).join(":")}::/64`;
}

function rawAddress(c: Context, trustProxy: boolean): string | undefined {
  if (trustProxy) {
    const cf = c.req.header("cf-connecting-ip")?.trim();
    if (cf) return cf;
    const hops = c.req.header("x-forwarded-for")?.split(",");
    const appended = hops !== undefined && hops.length >= 3 ? hops[hops.length - 3]?.trim() : "";
    if (appended) return appended;
  }
  try {
    return getConnInfo(c).remote.address || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fixed-window limiter (INCR + EXPIRE NX in one MULTI) that advertises its quota with the
 * `RateLimit-Policy` and `RateLimit` fields of draft-ietf-httpapi-ratelimit-headers-11.
 * It fails open when the store is unreachable, unless `failClosed` is set; the idempotency
 * middleware guards writes.
 */
export function rateLimit(kv: RedisClientType, options: RateLimitOptions = {}): MiddlewareHandler {
  const {
    name = "default",
    limit = 600,
    anonymousLimit = 120,
    windowSec = 60,
    trustProxy = false,
    failClosed = false,
  } = options;
  const unavailable = (c: Context) =>
    problem(
      c,
      503,
      "dependency-unavailable",
      "Dependency unavailable",
      "The rate limit store is unreachable.",
    );
  return async (c, next) => {
    const principal = c.get("principal");
    const owner =
      principal === undefined
        ? `ip:${clientAddress(c, trustProxy) ?? "unknown"}`
        : principalKey(principal);
    const quota = principal === undefined ? anonymousLimit : limit;
    const nowSec = Math.floor(Date.now() / 1000);
    const window = Math.floor(nowSec / windowSec);
    const reset = (window + 1) * windowSec - nowSec;

    let count: number;
    try {
      const key = `rl:${name}:${owner}:${window}`;
      const [incr] = await kv.multi().incr(key).expire(key, windowSec, "NX").exec();
      count = Number(incr);
      if (!Number.isFinite(count)) return failClosed ? unavailable(c) : next();
    } catch {
      return failClosed ? unavailable(c) : next();
    }

    const remaining = Math.max(quota - count, 0);
    // Each limiter on the path adds its own item to the `RateLimit-Policy` and `RateLimit` lists.
    c.header("RateLimit-Policy", `"${name}";q=${quota};w=${windowSec}`, { append: true });
    c.header("RateLimit", `"${name}";r=${remaining};t=${reset}`, { append: true });
    if (count > quota) {
      c.header("Retry-After", String(reset));
      return problem(c, 429, "rate-limited", "Too many requests", `Retry after ${reset} seconds.`);
    }
    await next();
  };
}
