import { calculateJwkThumbprint } from "jose";
import { pino } from "pino";
import { describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { createTee } from "../src/tee/config.ts";
import { refreshLeg } from "../src/tee/signers.ts";
import { testDb, testKv } from "./setup.ts";
import { live, liveEnv } from "./tee-live.ts";

const log = pino({ level: "silent" });

test("without a TEE leg there is no attested issuer key to serve", async () => {
  const app = createApp({ db: testDb, kv: testKv, log });
  const res = await app.request("/v1/credentials/issuer/jwks.json");
  expect(res.status).toBe(503);
  expect((await res.json()).type).toBe("https://api.keelson.finance/problems/tee-unavailable");
});

describe.skipIf(!live)("with the live TEE legs", () => {
  test("serves leg A's credential issuer key, the one its admitted attestation binds", async () => {
    const tee = createTee(liveEnv(), { a: 10_000, b: 10_000 });
    const app = createApp({ db: testDb, kv: testKv, log, tee });
    await refreshLeg(testDb, "a", tee);
    const res = await app.request("/v1/credentials/issuer/jwks.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const { keys } = (await res.json()) as { keys: { kid: string; kty: string }[] };
    const health = (await tee.client.a.health()) as unknown as { issuer: Record<string, string> };
    expect(keys).toHaveLength(1);
    expect(keys[0]?.kid).toBe(await calculateJwkThumbprint(health.issuer as never, "sha256"));
  }, 60_000);
});
