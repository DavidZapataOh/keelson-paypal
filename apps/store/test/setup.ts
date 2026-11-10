import { createPayPal, paypalConfig, TokenCache } from "@keelson/paypal";
import { pino } from "pino";
import { createClient, type RedisClientType } from "redis";
import { afterAll } from "vitest";
import { createApp, type StoreDeps } from "../src/app.ts";

export const ORIGIN = "https://store.keelson.finance";
export const TOKEN = "test-attack-token-0123456789abcdef";

const kv = createClient({ url: process.env.REDIS_URL as string }) as RedisClientType;
await kv.connect();
afterAll(() => kv.close());

const cfg = paypalConfig({ ...process.env, PAYPAL_ENV: "sandbox" });

export const deps: StoreDeps = {
  paypal: createPayPal(cfg, new TokenCache(cfg)),
  clientId: cfg.clientId,
  environment: cfg.env,
  kv,
  attackToken: TOKEN,
  origin: ORIGIN,
  log: pino({ level: "silent" }),
};

export const app = createApp(deps);

const LD = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;

/** Every JSON-LD block of a page, parsed. */
export function jsonLd(html: string): Record<string, unknown>[] {
  return [...html.matchAll(LD)].map((m) => JSON.parse(m[1] as string));
}

/** A request to the store at its public origin. */
export const req = (path: string, init?: RequestInit) => app.request(`${ORIGIN}${path}`, init);
