import { sha256, toHex } from "@keelson/core";
import type { MiddlewareHandler } from "hono";
import type { Logger } from "pino";
import type { RedisClientType } from "redis";
import { problem } from "../problem.ts";

export interface Principal {
  kind: "user" | "client";
  subject: string;
  scopes?: string[];
}

declare module "hono" {
  interface ContextVariableMap {
    principal: Principal | undefined;
    timedOut: boolean | undefined;
  }
}

/** The lock must outlive the request timeout (30 s) so a handler cannot outlast it. */
const LOCK_SECONDS = 60;
const DONE_SECONDS = 86_400;
const encoder = new TextEncoder();

interface Running {
  state: "running";
  fp: string;
}

interface Done {
  state: "done";
  fp: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

function fingerprint(method: string, target: string, body: Uint8Array): string {
  const head = encoder.encode(`${method}\0${target}\0`);
  const input = new Uint8Array(head.length + body.length);
  input.set(head, 0);
  input.set(body, head.length);
  return toHex(sha256(input));
}

/**
 * Enforces the `Idempotency-Key` header on POST requests (draft-ietf-httpapi-idempotency-key-header).
 * A timed-out request keeps its lock until the TTL expires, since the handler may still be running.
 * Downstream effects must also be idempotent at their own layer (PayPal-Request-Id, the database
 * state machine), because a lock that expires after a failed save can allow a later retry.
 */
export function idempotency(kv: RedisClientType, log: Logger): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "POST") return next();

    const idemKey = c.req.header("idempotency-key");
    if (idemKey === undefined || idemKey.length < 1 || idemKey.length > 255) {
      return problem(
        c,
        400,
        "idempotency-key-required",
        "Idempotency-Key required",
        "POST requests must carry an Idempotency-Key header of 1 to 255 characters.",
      );
    }

    const url = new URL(c.req.url);
    const fp = fingerprint(
      c.req.method,
      url.pathname + url.search,
      new Uint8Array(await c.req.arrayBuffer()),
    );
    const principal = c.get("principal");
    const owner =
      principal === undefined
        ? "anon"
        : Buffer.from(`${principal.kind}:${principal.subject}`).toString("base64url");
    const key = `idem:${owner}:${idemKey}`;
    const running: Running = { state: "running", fp };

    let locked: string | null;
    let existing: string | null = null;
    try {
      locked = await kv.set(key, JSON.stringify(running), { NX: true, EX: LOCK_SECONDS });
      if (locked === null) existing = await kv.get(key);
    } catch {
      return unavailable(c);
    }

    if (locked === null) {
      if (existing === null) {
        return problem(
          c,
          409,
          "idempotency-in-progress",
          "Request in progress",
          "A request with this Idempotency-Key is still being processed.",
        );
      }
      const entry = JSON.parse(existing) as Running | Done;
      if (entry.fp !== fp) {
        return problem(
          c,
          422,
          "idempotency-key-reused",
          "Idempotency-Key reused",
          "This Idempotency-Key was used with a different request.",
        );
      }
      if (entry.state === "running") {
        return problem(
          c,
          409,
          "idempotency-in-progress",
          "Request in progress",
          "A request with this Idempotency-Key is still being processed.",
        );
      }
      return new Response(Buffer.from(entry.body, "base64"), {
        status: entry.status,
        headers: { ...entry.headers, "idempotent-replayed": "true" },
      });
    }

    try {
      await next();
    } catch (err) {
      await release(kv, key);
      throw err;
    }

    if (c.get("timedOut")) return;

    const res = c.res;
    if (res.status >= 500) {
      await release(kv, key);
      return;
    }
    const headers: Record<string, string> = {};
    const contentType = res.headers.get("content-type");
    const location = res.headers.get("location");
    if (contentType !== null) headers["content-type"] = contentType;
    if (location !== null) headers.location = location;
    try {
      const done: Done = {
        state: "done",
        fp,
        status: res.status,
        headers,
        body: Buffer.from(await res.clone().arrayBuffer()).toString("base64"),
      };
      const saved = await kv.set(key, JSON.stringify(done), { XX: true, EX: DONE_SECONDS });
      if (saved === null) throw new Error("idempotency key vanished before the response was saved");
    } catch (err) {
      // The handler already ran: keep the lock so a retry gets 409 instead of a second execution.
      log.error({ err, requestId: c.get("requestId") }, "failed to save idempotent response");
    }
  };
}

async function release(kv: RedisClientType, key: string): Promise<void> {
  try {
    await kv.del(key);
  } catch {}
}

function unavailable(c: Parameters<typeof problem>[0]): Response {
  return problem(
    c,
    503,
    "dependency-unavailable",
    "Dependency unavailable",
    "The idempotency store is unreachable.",
  );
}
