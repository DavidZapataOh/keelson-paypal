import { OpenAPIHono } from "@hono/zod-openapi";
import type { Db } from "@keelson/db";
import type { Logger } from "pino";
import { registerHealth } from "./routes/health.ts";

export interface Deps {
  db: Db;
  log: Logger;
}

export const apiInfo = { title: "Keelson API", version: "0.0.0" } as const;

export function createApp(_deps: Deps): OpenAPIHono {
  const app = new OpenAPIHono();
  registerHealth(app);
  app.get("/openapi.json", (c) =>
    c.json(app.getOpenAPI31Document({ openapi: "3.1.0", info: apiInfo })),
  );
  return app;
}
