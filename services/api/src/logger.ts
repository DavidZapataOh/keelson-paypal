import { trace } from "@opentelemetry/api";
import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import { type DestinationStream, type Logger, pino } from "pino";

export function createLogger(destination?: DestinationStream): Logger {
  return pino(
    {
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          'res.headers["set-cookie"]',
          "headers.authorization",
          "headers.cookie",
          'headers["set-cookie"]',
        ],
        censor: "[redacted]",
      },
    },
    destination,
  );
}

/** Emits one line per request, keyed by the matched route pattern rather than the raw path. */
export function requestLogger(log: Logger): MiddlewareHandler {
  return async (c, next) => {
    const start = performance.now();
    try {
      await next();
    } finally {
      log.info(
        {
          req_id: c.get("requestId"),
          method: c.req.method,
          route: routePath(c, -1),
          status: c.res.status,
          ms: Math.round((performance.now() - start) * 100) / 100,
          trace_id: trace.getActiveSpan()?.spanContext().traceId,
        },
        "request",
      );
    }
  };
}
