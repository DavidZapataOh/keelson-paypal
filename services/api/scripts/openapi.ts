import { writeFileSync } from "node:fs";
import { createDb } from "@keelson/db";
import { pino } from "pino";
import { createClient, type RedisClientType } from "redis";
import { stringify } from "yaml";
import { apiInfo, createApp } from "../src/app.ts";

const { db, pool } = createDb("postgres://localhost/unused");
const kv = createClient() as RedisClientType;
const app = createApp({ db, kv, log: pino({ level: "silent" }) });
const doc = app.getOpenAPI31Document({ openapi: "3.1.0", info: apiInfo });
writeFileSync(new URL("../../../openapi/keelson.yaml", import.meta.url), stringify(doc));
await pool.end();
