import { eq, passkey as passkeyTable } from "@keelson/db";
import { pino } from "pino";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { createTee } from "../src/tee/config.ts";
import { refreshLeg } from "../src/tee/signers.ts";
import { testDb, testKv } from "./setup.ts";
import {
  asUser,
  headerPrincipal,
  live,
  liveEnv,
  seedPasskey,
  seedUser,
  signedMandate,
  VirtualPasskey,
} from "./tee-live.ts";

describe.skipIf(!live)("POST /v1/mandates with several passkeys (live leg A)", () => {
  const tee = createTee(liveEnv(), { a: 10_000, b: 10_000 });
  const app = createApp({
    db: testDb,
    kv: testKv,
    log: pino({ level: "silent" }),
    appOrigin: "https://app.keelson.finance",
    authenticate: headerPrincipal,
    tee,
    requestTimeoutMs: 60_000,
  });
  let laptop: VirtualPasskey;
  let phone: VirtualPasskey;

  beforeAll(async () => {
    [laptop, phone] = await Promise.all([VirtualPasskey.create(), VirtualPasskey.create()]);
    await refreshLeg(testDb, "a", tee);
    await refreshLeg(testDb, "b", tee);
  }, 60_000);
  afterAll(async () => {
    await Promise.all([laptop?.close(), phone?.close()]);
  });

  const register = async (passkey: VirtualPasskey, sub: string) => {
    const signed = await signedMandate(passkey, sub);
    const res = await app.request("/v1/mandates", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": ulid(), ...asUser(sub) },
      body: JSON.stringify(signed.body),
    });
    return { status: res.status, body: (await res.json()) as { id?: string; type?: string } };
  };
  const credentialOf = async (passkey: VirtualPasskey) =>
    (
      await testDb
        .select({ l1: passkeyTable.userCredential })
        .from(passkeyTable)
        .where(eq(passkeyTable.credentialID, passkey.credentialId))
    )[0]?.l1;

  test("each passkey of a user signs a mandate, with a user credential of its own", async () => {
    const sub = `kls_usr_${ulid().toLowerCase()}`;
    await seedUser(testDb, laptop, sub);
    expect((await register(laptop, sub)).status).toBe(201);

    await seedPasskey(testDb, phone, sub);
    const second = await register(phone, sub);
    expect(second.status, JSON.stringify(second.body)).toBe(201);

    const [l1Laptop, l1Phone] = [await credentialOf(laptop), await credentialOf(phone)];
    expect(l1Laptop).toMatch(/~$/);
    expect(l1Phone).toMatch(/~$/);
    expect(l1Phone).not.toBe(l1Laptop);

    // The stored user credential is presented again and accepted.
    expect((await register(phone, sub)).status).toBe(201);
    expect(await credentialOf(phone)).toBe(l1Phone);
  }, 180_000);
});
