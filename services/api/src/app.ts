import { httpInstrumentationMiddleware } from "@hono/otel";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Db } from "@keelson/db";
import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import { timeout } from "hono/timeout";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Logger } from "pino";
import type { RedisClientType } from "redis";
import { ulid } from "ulid";
import type { Auth } from "./auth.ts";
import { requestLogger } from "./logger.ts";
import { idempotency } from "./middleware/idempotency.ts";
import { type RateLimitOptions, rateLimit } from "./middleware/rate-limit.ts";
import { ProblemSchema, problem } from "./problem.ts";
import { registerEvents } from "./routes/events.ts";
import { registerHealth } from "./routes/health.ts";
import { registerStatus } from "./routes/status.ts";

export interface Deps {
  db: Db;
  kv: RedisClientType;
  log: Logger;
  /** Better Auth instance served at `/api/auth/*`. */
  auth?: Auth;
  /** Resolves `c.var.principal`; runs before idempotency so keys are scoped per principal. */
  authenticate?: MiddlewareHandler;
  /** Handler deadline in milliseconds; must stay below the idempotency lock lifetime. */
  requestTimeoutMs?: number;
  rateLimit?: RateLimitOptions;
  /** Aborting it ends every open event stream so the server can close. */
  shutdown?: AbortSignal;
}

export const apiInfo = { title: "Keelson API", version: "0.0.0" } as const;

export function createApp(deps: Deps): OpenAPIHono {
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return problem(
          c,
          422,
          "validation-failed",
          "Validation failed",
          "The request is invalid.",
          {
            errors: result.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          },
        );
      }
    },
  });

  app.use(httpInstrumentationMiddleware());
  app.use(requestId({ generator: () => ulid() }));
  app.use(requestLogger(deps.log));
  app.use(
    "/v1/*",
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) => problem(c, 413, "payload-too-large", "Payload too large"),
    }),
  );
  if (deps.authenticate) app.use("/v1/*", deps.authenticate);
  app.use("/v1/*", rateLimit(deps.kv, deps.rateLimit));
  app.use("/v1/*", idempotency(deps.kv, deps.log));
  app.use(
    "/v1/*",
    timeout(deps.requestTimeoutMs ?? 30_000, (c) => {
      c.set("timedOut", true);
      return new HTTPException(504, { message: "The request took too long." });
    }),
  );
  app.openAPIRegistry.register("Problem", ProblemSchema);

  app.notFound((c) => problem(c, 404, "not-found", "Not found"));
  app.onError((err, c) => {
    if (err instanceof HTTPException && err.status === 400) {
      return problem(c, 400, "malformed-body", "Malformed body", err.message);
    }
    if (err instanceof HTTPException && err.status === 504) {
      return problem(c, 504, "timeout", "Request timed out", err.message);
    }
    if (err instanceof HTTPException) {
      return problem(
        c,
        err.status as ContentfulStatusCode,
        "http-error",
        "Request failed",
        err.message,
      );
    }
    deps.log.error({ err, requestId: c.get("requestId") }, "unhandled error");
    const detail = process.env.NODE_ENV === "production" ? undefined : err.message;
    return problem(c, 500, "internal", "Internal server error", detail);
  });

  if (deps.auth) {
    const { auth } = deps;
    app.all("/api/auth/*", (c) => auth.handler(c.req.raw));
  }
  registerHealth(app);
  registerStatus(app, deps);
  registerEvents(app, deps);
  app.get("/openapi.json", (c) =>
    c.json(app.getOpenAPI31Document({ openapi: "3.1.0", info: apiInfo })),
  );
  return app;
}
