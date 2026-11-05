import { createRoute, z } from "@hono/zod-openapi";
import { pino } from "pino";
import { expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { testDb, testKv } from "./setup.ts";

const app = createApp({ db: testDb, kv: testKv, log: pino({ level: "silent" }) });

app.openapi(
  createRoute({
    method: "post",
    path: "/test/echo",
    request: {
      body: {
        content: { "application/json": { schema: z.object({ name: z.string().min(1) }) } },
      },
    },
    responses: { 200: { description: "ok" } },
  }),
  (c) => c.body(null, 200),
);

app.get("/test/boom", () => {
  throw new Error("kaboom");
});

const json = { "content-type": "application/json" };

test("an invalid body returns a 422 validation-failed problem", async () => {
  const res = await app.request("/test/echo", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ name: 1 }),
  });
  expect(res.status).toBe(422);
  expect(res.headers.get("content-type")).toContain("application/problem+json");
  const body = await res.json();
  expect(body).toMatchObject({
    type: "https://api.keelson.finance/problems/validation-failed",
    title: "Validation failed",
    status: 422,
    instance: "/test/echo",
  });
  expect(body.errors[0]).toMatchObject({ path: "name" });
});

test("malformed JSON returns a 400 malformed-body problem", async () => {
  const res = await app.request("/test/echo", { method: "POST", headers: json, body: "{" });
  expect(res.status).toBe(400);
  expect(res.headers.get("content-type")).toContain("application/problem+json");
  expect((await res.json()).type).toBe("https://api.keelson.finance/problems/malformed-body");
});

test("an unknown route returns a 404 not-found problem", async () => {
  const res = await app.request("/nope");
  expect(res.status).toBe(404);
  expect(res.headers.get("content-type")).toContain("application/problem+json");
  expect(await res.json()).toMatchObject({
    type: "https://api.keelson.finance/problems/not-found",
    instance: "/nope",
  });
});

test("an uncaught error returns a 500 internal problem without a stack", async () => {
  const res = await app.request("/test/boom");
  expect(res.status).toBe(500);
  expect(res.headers.get("content-type")).toContain("application/problem+json");
  const text = await res.text();
  expect(JSON.parse(text).type).toBe("https://api.keelson.finance/problems/internal");
  expect(text).not.toMatch(/at .*\.ts|stack/);
});

test("the Problem schema is a component of the document", async () => {
  const doc = await (await app.request("/openapi.json")).json();
  expect(doc.components.schemas.Problem).toBeDefined();
});
