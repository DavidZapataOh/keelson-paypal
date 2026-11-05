import { OpenAPIHono } from "@hono/zod-openapi";
import type { Db } from "@keelson/db";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Logger } from "pino";
import { ProblemSchema, problem } from "./problem.ts";
import { registerHealth } from "./routes/health.ts";

export interface Deps {
  db: Db;
  log: Logger;
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

  app.use(requestId());
  app.openAPIRegistry.register("Problem", ProblemSchema);

  app.notFound((c) => problem(c, 404, "not-found", "Not found"));
  app.onError((err, c) => {
    if (err instanceof HTTPException && err.status === 400) {
      return problem(c, 400, "malformed-body", "Malformed body", err.message);
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

  registerHealth(app);
  app.get("/openapi.json", (c) =>
    c.json(app.getOpenAPI31Document({ openapi: "3.1.0", info: apiInfo })),
  );
  return app;
}
