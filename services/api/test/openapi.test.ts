import { readFileSync } from "node:fs";
import { type SpecData, Validator } from "@seriousme/openapi-schema-validator";
import { pino } from "pino";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { createApp } from "../src/app.ts";
import { testDb, testKv } from "./setup.ts";

const app = createApp({ db: testDb, kv: testKv, log: pino({ level: "silent" }) });

async function liveDocument(): Promise<SpecData> {
  return (await app.request("/openapi.json")).json() as Promise<SpecData>;
}

test("the served document is valid OpenAPI 3.1", async () => {
  const result = await new Validator().validate(await liveDocument());
  expect(result.errors).toBeUndefined();
  expect(result.valid).toBe(true);
});

test("openapi/keelson.yaml matches the live document", async () => {
  const file = readFileSync(new URL("../../../openapi/keelson.yaml", import.meta.url), "utf8");
  expect(parse(file)).toEqual(await liveDocument());
});

test("every operation has a unique operationId", async () => {
  const doc = (await liveDocument()) as {
    paths: Record<string, Record<string, { operationId?: string }>>;
  };
  const ids = Object.values(doc.paths).flatMap((ops) =>
    Object.values(ops).map((op) => op.operationId),
  );
  expect(ids.every((id) => typeof id === "string" && /^[a-z][A-Za-z0-9]*$/.test(id))).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);
});

test("a guarded route documents the security its guard enforces", async () => {
  const doc = (await liveDocument()) as {
    paths: Record<string, Record<string, { security?: Record<string, string[]>[] }>>;
    components: { securitySchemes: Record<string, unknown> };
  };
  expect(Object.keys(doc.components.securitySchemes).sort()).toEqual(["oauth2", "session"]);
  expect(doc.paths["/v1/countersign"]?.post?.security).toEqual([
    { oauth2: ["countersign:write"] },
    { oauth2: ["purchases:write"] },
  ]);
  expect(doc.paths["/v1/evidence"]?.post?.security).toEqual([{ oauth2: ["evidence:write"] }]);
  expect(doc.paths["/v1/passkeys"]?.get?.security).toEqual([{ session: [] }]);
  expect(doc.paths["/v1/alibis/verify"]?.post?.security).toBeUndefined();
});
