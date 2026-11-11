import { writeFileSync } from "node:fs";
import { createDb } from "@keelson/db";
import { pino } from "pino";
import { createClient, type RedisClientType } from "redis";
import { stringify } from "yaml";
import { createApp, openApiDocument } from "../src/app.ts";

const { db, pool } = createDb("postgres://localhost/unused");
const kv = createClient() as RedisClientType;
const app = createApp({ db, kv, log: pino({ level: "silent" }) });
const doc = openApiDocument(app);
writeFileSync(new URL("../../../openapi/keelson.yaml", import.meta.url), stringify(doc));
await pool.end();
