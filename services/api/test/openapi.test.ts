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
