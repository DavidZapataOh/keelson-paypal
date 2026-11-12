import { randomBytes } from "node:crypto";
import { user } from "@keelson/db";
import { createLocalJWKSet, decodeProtectedHeader, type JWTPayload, jwtVerify } from "jose";
import { pino } from "pino";
import { ulid } from "ulid";
import { describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth.ts";
import { CAEP_SESSION_REVOKED } from "../src/ssf.ts";
import { testAuthEnv, testDb, testKv } from "./setup.ts";
import { asUser, headerPrincipal } from "./tee-live.ts";

const base = "https://api.keelson.finance";
const auth = createAuth(testDb, testAuthEnv(base, randomBytes(32).toString("base64url")));
const app = createApp({
  db: testDb,
  kv: testKv,
  log: pino({ level: "silent" }),
  auth,
  authBaseUrl: base,
  authenticate: headerPrincipal,
});

async function newUser(): Promise<string> {
  const id = `user-${ulid()}`;
  await testDb.insert(user).values({ id, name: "Buyer", email: `${id}@example.test` });
  return id;
}

/** An app acting for `userId`, with a token the user delegated to it. */
const asApp = (clientId: string, userId: string) => ({
  "x-test-principal": JSON.stringify({
    kind: "client",
    subject: clientId,
    scopes: ["alibis:read"],
    user: userId,
  }),
});

const send = (path: string, headers: Record<string, string>, body?: unknown, method = "POST") =>
  app.request(path, {
    method,
    headers: { "idempotency-key": ulid(), "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function stream(clientId: string, userId: string) {
  const res = await send("/ssf/streams", asApp(clientId, userId), {
    delivery: { method: "urn:ietf:rfc:8936" },
    events_requested: [CAEP_SESSION_REVOKED],
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { stream_id: string; delivery: { endpoint_url: string } };
}

const poll = (clientId: string, userId: string, body: Record<string, unknown> = {}) =>
  send("/ssf/poll", asApp(clientId, userId), { returnImmediately: true, ...body });

describe("OpenID Shared Signals transmitter (SSF 1.0, CAEP 1.0, RFC 8936 poll)", () => {
  test("publishes its configuration", async () => {
    const config = await (await app.request("/.well-known/ssf-configuration")).json();
    expect(config).toMatchObject({
      spec_version: "1_0",
      issuer: base,
      jwks_uri: `${base}/api/auth/jwks`,
      delivery_methods_supported: ["urn:ietf:rfc:8936"],
      configuration_endpoint: `${base}/ssf/streams`,
      authorization_schemes: [{ spec_urn: "urn:ietf:rfc:6749" }],
    });
  });

  test("a stop reaches the app's stream as a signed CAEP session-revoked event, once", async () => {
    const userId = await newUser();
    const clientId = `app-${ulid()}`;
    const created = await stream(clientId, userId);
    expect(created.delivery.endpoint_url).toBe(`${base}/ssf/poll`);
    // One stream per app and user.
    const again = await send("/ssf/streams", asApp(clientId, userId), {
      delivery: { method: "urn:ietf:rfc:8936" },
    });
    expect(again.status).toBe(409);
    // Another user's app hears nothing of this user.
    const otherUser = await newUser();
    await stream(`app-${ulid()}`, otherUser);

    const stopped = await send("/v1/agents/stop", asUser(userId));
    expect(stopped.status).toBe(200);
    const stopAt = Date.parse(((await stopped.json()) as { createdAt: string }).createdAt);

    const started = performance.now();
    const { sets } = (await (await poll(clientId, userId)).json()) as {
      sets: Record<string, string>;
    };
    expect(performance.now() - started).toBeLessThan(2_000);
    const [[jti, set]] = Object.entries(sets) as [[string, string]];
    expect(decodeProtectedHeader(set).typ).toBe("secevent+jwt");
    const jwks = await (await app.request("/api/auth/jwks")).json();
    const { payload } = await jwtVerify<JWTPayload & Record<string, unknown>>(
      set,
      createLocalJWKSet(jwks),
      { issuer: base, audience: clientId, typ: "secevent+jwt" },
    );
    expect(payload.jti).toBe(jti);
    expect(payload.sub_id).toEqual({ format: "iss_sub", iss: base, sub: userId });
    const event = (payload.events as Record<string, { event_timestamp: number }>)[
      CAEP_SESSION_REVOKED
    ];
    expect(event?.event_timestamp).toBe(Math.floor(stopAt / 1000));

    // Acknowledged, it is not sent again.
    await poll(clientId, userId, { ack: [jti] });
    expect(((await (await poll(clientId, userId)).json()) as { sets: object }).sets).toEqual({});
  });

  test("the other user's stream got nothing, and only the app may read its stream", async () => {
    const userId = await newUser();
    const clientId = `app-${ulid()}`;
    await stream(clientId, userId);
    await send("/v1/agents/stop", asUser(await newUser()));
    expect(((await (await poll(clientId, userId)).json()) as { sets: object }).sets).toEqual({});
    const asSession = await send("/ssf/poll", asUser(userId), {});
    expect(asSession.status).toBe(403);
  });

  test("a deleted stream is gone", async () => {
    const userId = await newUser();
    const clientId = `app-${ulid()}`;
    const { stream_id } = await stream(clientId, userId);
    const res = await send(
      `/ssf/streams?stream_id=${stream_id}`,
      asApp(clientId, userId),
      undefined,
      "DELETE",
    );
    expect(res.status).toBe(204);
    expect((await poll(clientId, userId)).status).toBe(404);
  });
});
