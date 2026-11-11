import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { agentConnections, eq, mandates, oauthClient, operators, passkey, user } from "@keelson/db";
import { type Mandate, prepareSigning } from "@keelson/mandate";
import { pino } from "pino";
import { type BrowserContext, chromium, type Frame, type Page } from "playwright";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { termsConsent } from "../src/compile-sources.ts";
import { hashDeviceCode } from "../src/connections.ts";
import { engineSource } from "../src/tee/engine-source.ts";
import { testDb, testKv } from "./setup.ts";
import { asUser, headerPrincipal } from "./tee-live.ts";

const API = "https://api.keelson.finance";
const HOST = "https://agents.example.com";
const EVIL = "https://evil.example.net";
const REGISTRY = "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e";
const NO_EVIDENCE = { merchantSignedCheckout: false, zkTlsFields: new Set<never>() };

let app!: OpenAPIHono;
const server = serve({ fetch: (req, env) => app.fetch(req, env), port: 0, hostname: "127.0.0.1" });
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const port = (server.address() as AddressInfo).port;

// The page the test frames on the API's origin: WebAuthn and the embed API, nothing else.
const FRAME = `<!doctype html><html lang="en"><title>Approve</title><button id="create">Create</button><script>
window.call = async (path, init = {}) => {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID(), "keelson-device": "test-device", "keelson-embed": window.session, ...(init.headers || {}) } });
  return { status: res.status, body: await res.json().catch(() => null) };
};
window.created = null;
document.getElementById("create").onclick = () => {
  window.created = navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(window.creation) }).then((c) => c.toJSON(), (e) => ({ error: e.name }));
};
window.assert = (options) => navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options) }).then((c) => c.toJSON(), (e) => ({ error: e.name }));
</script></html>`;

app = createApp({
  db: testDb,
  kv: testKv,
  log: pino({ level: "silent" }),
  authenticate: headerPrincipal,
  appOrigin: "https://app.keelson.finance",
  authBaseUrl: API,
  embedPage: async () => FRAME,
  compileSources: { consent: termsConsent, engine: engineSource },
});
app.get("/test-frame", (c) => c.html(FRAME));

let browser!: Awaited<ReturnType<typeof chromium.launch>>;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
});

const asClient = (subject: string) => ({
  "x-test-principal": JSON.stringify({ kind: "client", subject, scopes: ["countersign:write"] }),
});

const send = (path: string, headers: Record<string, string>, body?: unknown, method = "POST") =>
  app.request(path, {
    method,
    headers: {
      "idempotency-key": ulid(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function newAgentJwk() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const { x, y } = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kty: "EC", crv: "P-256", x: x as string, y: y as string };
}

/** An agent platform with a registered operator, embedding on `HOST`, and one pending request. */
async function embedded() {
  const clientId = `platform-${ulid()}`;
  await testDb.insert(oauthClient).values({ id: ulid(), clientId, redirectUris: [] });
  await testDb.insert(operators).values({
    agentId: BigInt(`0x${randomBytes(8).toString("hex")}`),
    chainId: 421614,
    agentRegistry: REGISTRY,
    name: "Errand Labs",
    cnfJwk: await newAgentJwk(),
    clientId,
  });
  expect(
    (await send("/v1/embed/origins", asClient(clientId), { origins: [HOST] }, "PUT")).status,
  ).toBe(200);
  const asked = await send("/v1/connections", asClient(clientId), {
    name: "Shopping agent",
    reason:
      "I am the shopping agent on this platform. You asked me to buy running shoes under $120 at RunFast; I check out only what you approve here.",
    limits: {
      perPurchaseMinor: 5_000,
      totalMinor: 10_000,
      merchants: ["mrc_runfast"],
      until: new Date(Date.now() + 86_400_000).toISOString(),
    },
  });
  expect(asked.status, await asked.clone().text()).toBe(201);
  const { device_code } = (await asked.json()) as { device_code: string };
  const minted = await send("/v1/connections/embed", asClient(clientId), {
    device_code,
    origin: HOST,
  });
  expect(minted.status, await minted.clone().text()).toBe(201);
  const { url } = (await minted.json()) as { url: string };
  const token = new URLSearchParams(new URL(url).hash.slice(1)).get("t") ?? "";
  const opened = await send("/v1/embed/sessions", {}, { token });
  const { session, embed } = (await opened.json()) as {
    session: string;
    embed: { ref: string; request: { code: string } };
  };
  const [request] = await testDb
    .select()
    .from(agentConnections)
    .where(eq(agentConnections.deviceCodeHash, hashDeviceCode(device_code)));
  expect(embed.ref).toMatch(/^[0-9A-Z]{26}$/);
  return { clientId, session, requestId: request?.id as string };
}

async function newUser(): Promise<string> {
  const id = ulid();
  await testDb.insert(user).values({ id, name: "Ada", email: `${id}@example.com` });
  return id;
}

interface Framed {
  ctx: BrowserContext;
  page: Page;
  frame: Frame;
  /** The same page and authenticator, now on `top` framing the approval for `session`. */
  reframe(top: string, session: string): Promise<Frame>;
}

/** `top` framing the approval's origin with the passkey features delegated, in a fresh browser. */
async function framed(top: string, session: string): Promise<Framed> {
  const ctx = await browser.newContext();
  for (const origin of [HOST, EVIL]) {
    await ctx.route(`${origin}/`, (r) =>
      r.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en"><title>Platform</title><iframe title="Keelson" src="${API}/test-frame" allow="publickey-credentials-get; publickey-credentials-create"></iframe></html>`,
      }),
    );
  }
  // The API answers on its production origin, so the browser writes that origin into assertions.
  await ctx.route(`${API}/**`, async (r) => {
    const u = new URL(r.request().url());
    const req = r.request();
    const res = await r.fetch({ url: `http://127.0.0.1:${port}${u.pathname}${u.search}` });
    const headers = res.headers();
    if (u.pathname === "/test-frame" && req.method() === "GET") {
      headers["permissions-policy"] =
        "publickey-credentials-get=(self), publickey-credentials-create=(self)";
      // Both pages may frame it here, so a test can sign under the wrong one.
      headers["content-security-policy"] = `frame-ancestors ${HOST} ${EVIL}`;
      delete headers["x-frame-options"];
    }
    await r.fulfill({ response: res, headers });
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const reframe = async (at: string, s: string) => {
    await page.goto(`${at}/`);
    const frame = page.frames().find((f) => f.url() === `${API}/test-frame`) as Frame;
    await frame.waitForFunction("window.call !== undefined");
    await frame.evaluate((value) => {
      (window as unknown as { session: string }).session = value;
    }, s);
    return frame;
  };
  return { ctx, page, frame: await reframe(top, session), reframe };
}

type Call = { status: number; body: Record<string, unknown> };
const call = (frame: Frame, path: string, body?: unknown): Promise<Call> =>
  frame.evaluate(
    ([path, body]) =>
      (window as unknown as { call(p: string, i: RequestInit): Promise<Call> }).call(path, {
        method: "POST",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    [path, body] as const,
  );

/** Links the session to `userId` as the Keelson window does, then creates a passkey in the frame. */
async function createPasskey(frame: Frame, userId: string): Promise<string> {
  const link = await call(frame, "/v1/embed/links");
  expect(link.status).toBe(201);
  const confirmed = await send("/v1/embed/links/confirm", asUser(userId), {
    nonce: link.body.nonce,
  });
  expect(confirmed.status).toBe(200);
  expect(await confirmed.json()).toEqual({ origin: HOST });
  const options = await call(frame, "/v1/embed/passkeys/options", { platform: false });
  expect(options.status).toBe(200);
  await frame.evaluate((o) => {
    (window as unknown as { creation: unknown }).creation = o;
  }, options.body);
  // A cross-origin frame creates a passkey only on a user activation there.
  await frame.locator("#create").click();
  const credential = await frame.evaluate("window.created");
  const created = await call(frame, "/v1/embed/passkeys", credential);
  expect(created.status).toBe(201);
  return (created.body.credentialId as string) ?? "";
}

async function signIn(frame: Frame): Promise<Call> {
  const options = await call(frame, "/v1/embed/sign-in/options");
  const assertion = await frame.evaluate(
    (o) => (window as unknown as { assert(o: unknown): Promise<unknown> }).assert(o),
    options.body,
  );
  return call(frame, "/v1/embed/sign-in", assertion);
}

/** Drafts the request's mandate in the frame and signs it there; returns the body to store. */
async function signed(frame: Frame, credentialId: string) {
  const draft = await call(frame, "/v1/embed/draft", {
    credentialId,
    limits: {
      perPurchaseMinor: 4_000,
      totalMinor: 8_000,
      merchants: ["mrc_runfast"],
      until: new Date(Date.now() + 43_200_000).toISOString(),
    },
  });
  expect(draft.status).toBe(200);
  const m = draft.body.mandateDraft as Mandate;
  const s = await prepareSigning(m, randomBytes(16), NO_EVIDENCE, []);
  const assertion = (await frame.evaluate(
    ([challenge, id]) =>
      (window as unknown as { assert(o: unknown): Promise<Record<string, unknown>> }).assert({
        challenge,
        rpId: "keelson.finance",
        userVerification: "required",
        allowCredentials: [{ type: "public-key", id }],
      }),
    [Buffer.from(s.challenge).toString("base64url"), credentialId] as const,
  )) as { id: string; response: Record<string, string> };
  return {
    m,
    body: {
      payloadSd: s.payloadSd,
      disclosures: s.disclosures,
      commitment: s.commitment,
      salt: s.salt,
      assertion: {
        authenticatorData: assertion.response.authenticatorData,
        clientDataJSON: assertion.response.clientDataJSON,
        signature: assertion.response.signature,
        credentialId: assertion.id,
      },
    },
  };
}

describe("signing in the embedded approval", () => {
  test("a new user creates a passkey and approves, all in the frame", {
    timeout: 60_000,
  }, async () => {
    const { session, requestId } = await embedded();
    const userId = await newUser();
    const { ctx, frame } = await framed(HOST, session);
    try {
      const credentialId = await createPasskey(frame, userId);
      const [stored] = await testDb.select().from(passkey).where(eq(passkey.userId, userId));
      expect(stored?.credentialID).toBe(credentialId);

      const { m, body } = await signed(frame, credentialId);
      expect(m.embed).toEqual({ top_origin: HOST });
      const clientData = JSON.parse(
        Buffer.from(body.assertion.clientDataJSON ?? "", "base64url").toString(),
      ) as Record<string, unknown>;
      expect(clientData).toMatchObject({ origin: API, crossOrigin: true, topOrigin: HOST });
      const created = await call(frame, "/v1/embed/mandates", { ...body, askAboveMinor: 3_000 });
      expect(created.status).toBe(201);
      expect(created.body.id).toBe(m.mid);

      const [request] = await testDb
        .select()
        .from(agentConnections)
        .where(eq(agentConnections.id, requestId));
      expect(request).toMatchObject({ state: "APPROVED", userId, mandateId: m.mid });
      const [mandate] = await testDb.select().from(mandates).where(eq(mandates.id, m.mid));
      expect(mandate?.payloadSd).toMatchObject({ embed: { top_origin: HOST } });
    } finally {
      await ctx.close();
    }
  });

  test("a user with a passkey signs in with it in the frame and approves", {
    timeout: 60_000,
  }, async () => {
    const userId = await newUser();
    const first = await embedded();
    const f = await framed(HOST, first.session);
    try {
      const credentialId = await createPasskey(f.frame, userId);
      // Another request, another session: nothing ties it to the user until the passkey does.
      const { session } = await embedded();
      const frame = await f.reframe(HOST, session);
      expect((await call(frame, "/v1/embed/passkeys/options", { platform: false })).status).toBe(
        401,
      );
      const signedIn = await signIn(frame);
      expect(signedIn.status).toBe(200);
      expect(signedIn.body).toEqual({
        credentialId,
        passkeys: [{ credentialId, payment: false }],
      });
      const { body } = await signed(frame, credentialId);
      const created = await call(frame, "/v1/embed/mandates", { ...body, askAboveMinor: 3_000 });
      expect(created.status).toBe(201);
      // The assertion answered this request once; it signs no other.
      expect((await call(frame, "/v1/embed/mandates", body)).status).toBe(404);
    } finally {
      await f.ctx.close();
    }
  });
});

describe("the embedded approval refuses", () => {
  test("a passkey sign-in made under another top-level page", { timeout: 60_000 }, async () => {
    const userId = await newUser();
    const { session } = await embedded();
    const f = await framed(HOST, session);
    try {
      await createPasskey(f.frame, userId);
      const next = await embedded();
      // The platform's session, signed in on a page the embed was not minted for.
      const evil = await f.reframe(EVIL, next.session);
      const forged = await signIn(evil);
      expect(forged.status).toBe(401);
      // Under the platform's page, the same passkey signs in.
      const host = await f.reframe(HOST, next.session);
      expect((await signIn(host)).status).toBe(200);
    } finally {
      await f.ctx.close();
    }
  });

  test("a mandate signed under another top-level page, or naming one", {
    timeout: 60_000,
  }, async () => {
    const userId = await newUser();
    const { session } = await embedded();
    const f = await framed(HOST, session);
    try {
      const credentialId = await createPasskey(f.frame, userId);
      const { body } = await signed(f.frame, credentialId);
      // Signed on the platform's page, with the payload then naming another one.
      const payloadSd = { ...body.payloadSd, embed: { top_origin: EVIL } };
      const renamed = await call(f.frame, "/v1/embed/mandates", { ...body, payloadSd });
      expect(renamed.status).toBe(422);
      // The top-level route never takes a mandate with embed.
      expect((await send("/v1/mandates", asUser(userId), body)).status).toBe(422);

      // The platform's mandate signed in a frame under another page: topOrigin names that page.
      const evil = await f.reframe(EVIL, session);
      const forged = await signed(evil, credentialId);
      const clientData = JSON.parse(
        Buffer.from(forged.body.assertion.clientDataJSON ?? "", "base64url").toString(),
      ) as Record<string, unknown>;
      expect(clientData).toMatchObject({ crossOrigin: true, topOrigin: EVIL });
      const refused = await call(evil, "/v1/embed/mandates", forged.body);
      expect(refused.status).toBe(401);
      expect(refused.body.type).toMatch(/\/invalid-signature$/);
    } finally {
      await f.ctx.close();
    }
  });

  test("an origin the platform no longer registers", { timeout: 60_000 }, async () => {
    const userId = await newUser();
    const { clientId, session } = await embedded();
    const f = await framed(HOST, session);
    try {
      const credentialId = await createPasskey(f.frame, userId);
      const { body } = await signed(f.frame, credentialId);
      const other = { origins: ["https://other.example.com"] };
      expect((await send("/v1/embed/origins", asClient(clientId), other, "PUT")).status).toBe(200);
      const refused = await call(f.frame, "/v1/embed/mandates", body);
      expect(refused.status).toBe(403);
      expect(refused.body.type).toMatch(/\/origin-not-allowed$/);
    } finally {
      await f.ctx.close();
    }
  });

  test("a passkey created at the top level of the approval's origin", {
    timeout: 60_000,
  }, async () => {
    const userId = await newUser();
    const { session } = await embedded();
    const f = await framed(HOST, session);
    try {
      const link = await call(f.frame, "/v1/embed/links");
      await send("/v1/embed/links/confirm", asUser(userId), { nonce: link.body.nonce });
      const options = await call(f.frame, "/v1/embed/passkeys/options", { platform: false });
      await f.page.goto(`${API}/test-frame`);
      await f.page.evaluate((o) => {
        (window as unknown as { creation: unknown }).creation = o;
      }, options.body);
      await f.page.locator("#create").click();
      const credential = await f.page.evaluate("window.created");
      const frame = await f.reframe(HOST, session);
      const refused = await call(frame, "/v1/embed/passkeys", credential);
      expect(refused.status).toBe(422);
      expect(await testDb.select().from(passkey).where(eq(passkey.userId, userId))).toEqual([]);
    } finally {
      await f.ctx.close();
    }
  });

  test("a link spent twice, and a passkey without a linked user", async () => {
    const userId = await newUser();
    const { session } = await embedded();
    const f = await framed(HOST, session);
    try {
      expect((await call(f.frame, "/v1/embed/passkeys/options", { platform: false })).status).toBe(
        401,
      );
      const link = await call(f.frame, "/v1/embed/links");
      expect((await send("/v1/embed/links/confirm", {}, link.body)).status).toBe(401);
      expect((await send("/v1/embed/links/confirm", asUser(userId), link.body)).status).toBe(200);
      expect((await send("/v1/embed/links/confirm", asUser(userId), link.body)).status).toBe(404);
    } finally {
      await f.ctx.close();
    }
  });
});
