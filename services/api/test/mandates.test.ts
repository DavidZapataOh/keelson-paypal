import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { serve } from "@hono/node-server";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { operators } from "@keelson/db";
import { type Mandate, parseMandate } from "@keelson/mandate";
import { cose, decodeCredentialPublicKey, isoBase64URL } from "@simplewebauthn/server/helpers";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { build } from "esbuild";
import { pino } from "pino";
import { type Browser, chromium, type Page } from "playwright";
import { ulid } from "ulid";
import { afterAll, beforeAll, expect, test } from "vitest";
import demo from "../../../packages/mandate/test/fixtures/demo-mandate.json" with { type: "json" };
import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth.ts";
import { authenticate } from "../src/middleware/auth.ts";
import { userPasskeys } from "../src/passkeys.ts";
import { testAuthEnv, testDb, testKv } from "./setup.ts";

const pageScript = `
import { createAuthClient } from "better-auth/client";
import { passkeyClient } from "@better-auth/passkey/client";
import {
  passkeyRegistrationOptions,
  prepareSigning,
  rememberPaymentPasskey,
  signMandate,
} from "@keelson/mandate/browser";

// The app and the API are separate origins, as app.keelson.finance and api.keelson.finance are.
const api = document.documentElement.dataset.api;
const call = (path, init) => fetch(api + path, { ...init, credentials: "include" });
const authClient = createAuthClient({
  baseURL: api,
  fetchOptions: { credentials: "include" },
  plugins: [passkeyClient()],
});
const noEvidence = { merchantSignedCheckout: false, zkTlsFields: new Set() };
const toBase64Url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

window.keelson = {
  addPasskey: async () => {
    const options = await passkeyRegistrationOptions();
    const { data, error } = await authClient.passkey.addPasskey({ name: "Test passkey", ...options });
    if (data && options.authenticatorAttachment === "platform") rememberPaymentPasskey(data.credentialID);
    return { data: data ?? null, error: error ?? null };
  },
  // The user confirms the card, then signs M with a passkey through SPC or plain WebAuthn.
  // \`shown\` replaces SPC dialog details, as a compromised page would.
  // \`passkeys\` defaults to the session user's list; a page without the session passes its own.
  sign: async (mandate, { spc, shown, passkeys: given }) => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const s = await prepareSigning(mandate, salt, noEvidence);
    const passkeys = given ?? (await (await call("/v1/passkeys")).json()).passkeys;
    const opts = spc ? { spc: { ...s.spc, ...shown } } : undefined;
    const assertion = await signMandate(s.challenge, passkeys, opts);
    const type = JSON.parse(atob(assertion.clientDataJSON.replaceAll("-", "+").replaceAll("_", "/"))).type;
    return {
      type,
      body: {
        payloadSd: s.payloadSd,
        disclosures: s.disclosures,
        commitment: s.commitment,
        assertion,
      },
    };
  },
  // A raw assertion over an arbitrary challenge, with the user verification the caller asks for.
  assert: async (challenge, credentialId, userVerification) => {
    const credential = await navigator.credentials.get({
      publicKey: PublicKeyCredential.parseRequestOptionsFromJSON({
        challenge,
        rpId: "keelson.finance",
        userVerification,
        allowCredentials: [{ id: credentialId, type: "public-key" }],
      }),
    });
    const r = credential.response;
    return {
      authenticatorData: toBase64Url(r.authenticatorData),
      clientDataJSON: toBase64Url(r.clientDataJSON),
      signature: toBase64Url(r.signature),
      credentialId: credential.id,
    };
  },
  passkeys: async () => (await call("/v1/passkeys")).json(),
  rememberPaymentPasskey,
  spcAvailable: async () => PaymentRequest.securePaymentConfirmationAvailability(),
  post: async (body, key) => {
    const res = await call("/v1/mandates", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      replayed: res.headers.get("idempotent-replayed"),
      location: res.headers.get("location"),
      body: await res.json(),
    };
  },
  get: async (id) => {
    const res = await call("/v1/mandates/" + id);
    return { status: res.status, body: await res.json() };
  },
};
`;

interface Signed {
  type: string;
  body: {
    payloadSd: Record<string, unknown>;
    disclosures: string[];
    commitment: string;
    assertion: { credentialId: string; clientDataJSON: string };
  };
}
interface Posted {
  status: number;
  replayed: string | null;
  location: string | null;
  body: { id?: string; mandateHash?: string; state?: string; type?: string; detail?: string };
}

const secret = randomBytes(32).toString("base64url");
let app!: OpenAPIHono;
const server = serve({ fetch: (req) => app.fetch(req), port: 0, hostname: "127.0.0.1" });
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const port = (server.address() as AddressInfo).port;
// Served under the production RP ID: Chromium resolves every host to this server, so the API,
// the app and the attacker's page are three origins.
const apiOrigin = `http://api.keelson.finance:${port}`;
const appOrigin = `http://app.keelson.finance:${port}`;
const evilOrigin = `http://evil.example:${port}`;

const auth = createAuth(testDb, { ...testAuthEnv(apiOrigin, secret), APP_ORIGIN: appOrigin });
app = createApp({
  db: testDb,
  kv: testKv,
  log: pino({ level: "silent" }),
  auth,
  appOrigin,
  authenticate: authenticate(auth, apiOrigin),
});

const bundle = await build({
  stdin: {
    contents: pageScript,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    loader: "js",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
  logLevel: "error",
});
const clientJs = bundle.outputFiles[0]?.text ?? "";
app.get("/test/client.js", (c) => c.body(clientJs, 200, { "content-type": "text/javascript" }));
app.get("/test", (c) =>
  c.html(
    `<!doctype html><html data-api="${apiOrigin}"><title>Keelson</title><script type="module" src="/test/client.js"></script></html>`,
  ),
);

const helpers = betterAuth({
  database: drizzleAdapter(testDb, { provider: "pg" }),
  secret,
  baseURL: apiOrigin,
  plugins: [testUtils()],
});

const operatorId = BigInt(`0x${randomBytes(8).toString("hex")}`);
let browser!: Browser;

beforeAll(async () => {
  await testDb.insert(operators).values({
    agentId: operatorId,
    chainId: 84532,
    name: "Test operator",
    cnfJwk: demo.agent.cnf.jwk,
  });
  // The full build: the headless shell has no Secure Payment Confirmation service. SPC is off by
  // default on Linux (`kSecurePaymentConfirmation` in content_features.cc), so it is enabled here.
  browser = await chromium.launch({
    channel: "chromium",
    args: [
      "--enable-features=SecurePaymentConfirmationBrowser",
      "--host-resolver-rules=MAP *.keelson.finance 127.0.0.1, MAP evil.example 127.0.0.1",
      `--unsafely-treat-insecure-origin-as-secure=${apiOrigin},${appOrigin},${evilOrigin}`,
    ],
  });
});

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
});

interface Signer {
  userId: string;
  /** Attaches a user-verifying platform authenticator, which makes SPC available. */
  addPlatformAuthenticator(): Promise<void>;
  transports: string | null;
  page: Page;
  credentialId: string;
  jwk: { x: string; y: string };
  setUserVerified(verified: boolean): Promise<void>;
}

/** A new signed-in user on the app page, with one passkey on a virtual authenticator. */
/** `userId` signs the user in from another browser profile, with a fresh authenticator. */
async function signer(
  transport: "internal" | "usb" = "internal",
  userId?: string,
): Promise<Signer> {
  const { test: utils } = await helpers.$context;
  const user = userId ? { id: userId } : await utils.saveUser(utils.createUser());
  const context = await browser.newContext({ baseURL: appOrigin });
  await context.addCookies(
    await utils.getCookies({ userId: user.id, domain: "api.keelson.finance" }),
  );
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const authenticator = (transport: "internal" | "usb") =>
    cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport,
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
      },
    });
  const { authenticatorId } = await authenticator(transport);
  await cdp.send("Page.setSPCTransactionMode", { mode: "autoAccept" });
  await page.goto("/test");
  await page.waitForFunction("window.keelson !== undefined");
  const added = await page.evaluate<{ error: unknown }>("window.keelson.addPasskey()");
  expect(added.error).toBeNull();
  const stored = (await userPasskeys(testDb, user.id)).at(-1);
  if (!stored) throw new Error("passkey was not stored");
  const key = decodeCredentialPublicKey(
    isoBase64URL.toBuffer(stored.publicKey, "base64"),
  ) as cose.COSEPublicKeyEC2;
  const coordinate = (bytes: Uint8Array | undefined) =>
    isoBase64URL.fromBuffer(new Uint8Array(bytes ?? []));
  return {
    userId: user.id,
    addPlatformAuthenticator: async () => {
      await authenticator("internal");
    },
    transports: stored.transports,
    page,
    credentialId: stored.credentialID,
    jwk: { x: coordinate(key.get(cose.COSEKEYS.x)), y: coordinate(key.get(cose.COSEKEYS.y)) },
    setUserVerified: async (isUserVerified) => {
      await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified });
    },
  };
}

function mandateFor(
  s: Pick<Signer, "userId" | "credentialId" | "jwk">,
  edit: (m: Mandate) => void = () => {},
): Mandate {
  const now = Math.floor(Date.now() / 1000);
  const m = parseMandate({
    ...structuredClone(demo),
    mid: ulid(),
    iat: now,
    nbf: now,
    exp: now + 7 * 86_400,
    user: {
      ...demo.user,
      sub: s.userId,
      cred: {
        id: s.credentialId,
        rp_id: "keelson.finance",
        jwk: { kty: "EC", crv: "P-256", ...s.jwk },
      },
    },
    agent: { ...demo.agent, operator: { ...demo.agent.operator, agent_id: String(operatorId) } },
  });
  edit(m);
  return m;
}

interface SignOptions {
  spc?: boolean;
  shown?: Record<string, unknown>;
  passkeys?: { credentialId: string; payment: boolean }[];
}

/** Signs `m` in the page with the session user's passkeys, as listed by `GET /v1/passkeys`. */
const sign = (page: Page, m: Mandate, opts: SignOptions = {}) =>
  page.evaluate(
    ([m, opts]) =>
      (window as unknown as { keelson: { sign(...a: unknown[]): Promise<Signed> } }).keelson.sign(
        m,
        opts,
      ),
    [m, { spc: true, ...opts }] as const,
  );

const post = (page: Page, body: unknown, key = `k-${crypto.randomUUID()}`) =>
  page.evaluate(
    ([body, key]) =>
      (window as unknown as { keelson: { post(...a: unknown[]): Promise<Posted> } }).keelson.post(
        body,
        key,
      ),
    [body, key] as const,
  );

const problemType = (slug: string) => `https://api.keelson.finance/problems/${slug}`;

test("a mandate signed through SPC is verified and stored as SIGNED", {
  timeout: 60_000,
}, async () => {
  const s = await signer();
  const m = mandateFor(s);
  expect(await passkeys(s.page)).toEqual({
    passkeys: [{ credentialId: s.credentialId, payment: true }],
  });
  const signed = await sign(s.page, m);
  expect(signed.type).toBe("payment.get");

  const key = `k-${crypto.randomUUID()}`;
  const created = await post(s.page, signed.body, key);
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ id: m.mid, state: "SIGNED" });
  expect(created.body.mandateHash).toMatch(/^0x[0-9a-f]{64}$/);
  expect(created.location).toBe(`/v1/mandates/${m.mid}`);

  const row = await testDb.query.mandates.findFirst({ where: (t, { eq }) => eq(t.id, m.mid) });
  expect(row).toMatchObject({
    userId: s.userId,
    state: "SIGNED",
    operatorAgentId: operatorId,
    currency: "USD",
    maxMinor: 10_000n,
    remainingMinor: 10_000n,
    merchantIds: ["mrc_runfast"],
    credentialId: s.credentialId,
    payloadSd: signed.body.payloadSd,
    disclosures: signed.body.disclosures,
    userAuth: signed.body.assertion,
  });
  expect(`0x${row?.mandateHash?.toString("hex")}`).toBe(created.body.mandateHash);
  expect(`0x${row?.commitment?.toString("hex")}`).toBe(signed.body.commitment);
  const [passkey] = await userPasskeys(testDb, s.userId);
  expect(passkey?.counter).toBeGreaterThan(0);

  const read = await s.page.evaluate<{ status: number; body: Record<string, unknown> }>(
    `window.keelson.get(${JSON.stringify(m.mid)})`,
  );
  expect(read.status).toBe(200);
  expect(read.body).toMatchObject({
    id: m.mid,
    state: "SIGNED",
    mandateHash: created.body.mandateHash,
  });
  expect(read.body.card).toMatchObject({ warnings: [expect.stringContaining("look good")] });

  const replay = await post(s.page, signed.body, key);
  expect(replay.status).toBe(201);
  expect(replay.replayed).toBe("true");
  expect(replay.body).toEqual(created.body);

  const again = await post(s.page, signed.body);
  expect(again.status).toBe(409);
  expect(again.body.type).toBe(problemType("mandate-exists"));
});

test("a plain WebAuthn signature is accepted too", { timeout: 60_000 }, async () => {
  const s = await signer();
  const signed = await sign(s.page, mandateFor(s), { spc: false });
  expect(signed.type).toBe("webauthn.get");
  expect((await post(s.page, signed.body)).status).toBe(201);
});

test("an assertion over a different challenge is rejected", { timeout: 60_000 }, async () => {
  const s = await signer();
  const a = await sign(s.page, mandateFor(s));
  const b = await sign(s.page, mandateFor(s));
  const res = await post(s.page, { ...b.body, assertion: a.body.assertion });
  expect(res.status).toBe(401);
  expect(res.body.type).toBe(problemType("invalid-signature"));
});

test("an assertion without user verification is rejected", { timeout: 60_000 }, async () => {
  const s = await signer();
  const signed = await sign(s.page, mandateFor(s));
  const challenge = JSON.parse(
    Buffer.from(signed.body.assertion.clientDataJSON, "base64url").toString(),
  ).challenge as string;
  await s.setUserVerified(false);
  const assertion = await s.page.evaluate(
    ([challenge, id]) =>
      (
        window as unknown as { keelson: { assert(...a: unknown[]): Promise<unknown> } }
      ).keelson.assert(challenge, id, "discouraged"),
    [challenge, s.credentialId] as const,
  );
  const res = await post(s.page, { ...signed.body, assertion });
  expect(res.status).toBe(401);
  expect(res.body.type).toBe(problemType("invalid-signature"));
  expect(res.body.detail).toBe("The passkey signature does not verify for this mandate.");
});

test("a signature made on another origin is rejected", { timeout: 60_000 }, async () => {
  const s = await signer();
  const m = mandateFor(s);
  await s.page.goto(`${evilOrigin}/test`);
  await s.page.waitForFunction("window.keelson !== undefined");
  // The attacker's page controls its own storage and knows the public credential id.
  await s.page.evaluate(`window.keelson.rememberPaymentPasskey(${JSON.stringify(s.credentialId)})`);
  const signed = await sign(s.page, m, {
    passkeys: [{ credentialId: s.credentialId, payment: true }],
  });
  expect(signed.type).toBe("payment.get");
  await s.page.goto(`${appOrigin}/test`);
  await s.page.waitForFunction("window.keelson !== undefined");
  const res = await post(s.page, signed.body);
  expect(res.status).toBe(401);
  expect(res.body.type).toBe(problemType("invalid-signature"));
});

test("another user's passkey cannot sign for the session user", { timeout: 60_000 }, async () => {
  const alice = await signer();
  const mallory = await signer();
  const signed = await sign(mallory.page, mandateFor(mallory));
  const res = await post(alice.page, signed.body);
  expect(res.status).toBe(403);
  expect(res.body.type).toBe(problemType("credential-not-owned"));

  const named = await sign(alice.page, mandateFor({ ...alice, jwk: mallory.jwk }));
  const mismatch = await post(alice.page, named.body);
  expect(mismatch.status).toBe(403);
  expect(mismatch.body.type).toBe(problemType("credential-not-owned"));

  const stored = await post(mallory.page, signed.body);
  expect(stored.status).toBe(201);
  const read = await alice.page.evaluate<{ status: number }>(
    `window.keelson.get(${JSON.stringify(stored.body.id)})`,
  );
  expect(read.status).toBe(404);
});

test("the commitment must be the one the payload carries", { timeout: 60_000 }, async () => {
  const s = await signer();
  const signed = await sign(s.page, mandateFor(s));
  const res = await post(s.page, { ...signed.body, commitment: `0x${"0".repeat(63)}1` });
  expect(res.status).toBe(422);
  expect(res.body.type).toBe(problemType("invalid-mandate"));
});

test("the server verifies and stores a signed mandate within budget", {
  timeout: 120_000,
}, async () => {
  const s = await signer();
  const bodies: Signed["body"][] = [];
  for (let i = 0; i < 50; i++) bodies.push((await sign(s.page, mandateFor(s))).body);
  const cookie = (await s.page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const ms: number[] = [];
  for (const body of bodies) {
    const started = performance.now();
    const res = await app.request("/v1/mandates", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    });
    ms.push(performance.now() - started);
    expect(res.status).toBe(201);
  }
  ms.sort((a, b) => a - b);
  const p95 = ms[Math.ceil(ms.length * 0.95) - 1] as number;
  expect(p95, `p95 ${p95.toFixed(2)} ms`).toBeLessThan(50);
});

test("SPC must have shown the mandate's payee and total", { timeout: 60_000 }, async () => {
  const s = await signer();
  for (const shown of [
    { total: { currency: "USD", value: "0.01" } },
    { payeeName: "Totally Different" },
    { payeeOrigin: "https://other.example" },
  ]) {
    const signed = await sign(s.page, mandateFor(s), { shown });
    expect(signed.type).toBe("payment.get");
    const res = await post(s.page, signed.body);
    expect(res.status, JSON.stringify(shown)).toBe(401);
    expect(res.body.type).toBe(problemType("invalid-signature"));
  }
});

const passkeys = (page: Page) =>
  page.evaluate<{ passkeys: { credentialId: string; payment: boolean }[] }>(
    "window.keelson.passkeys()",
  );

test("a security key registers and signs with plain WebAuthn", { timeout: 60_000 }, async () => {
  const s = await signer("usb");
  expect(s.transports).toContain("usb");
  expect(await passkeys(s.page)).toEqual({
    passkeys: [{ credentialId: s.credentialId, payment: false }],
  });
  const signed = await sign(s.page, mandateFor(s));
  expect(signed.type).toBe("webauthn.get");
  expect((await post(s.page, signed.body)).status).toBe(201);
});

test("on an SPC device, a security key still signs", { timeout: 60_000 }, async () => {
  const s = await signer("usb");
  await s.addPlatformAuthenticator();
  expect(await s.page.evaluate("window.keelson.spcAvailable()")).toBe("available");
  const signed = await sign(s.page, mandateFor(s));
  expect(signed.type).toBe("webauthn.get");
  expect((await post(s.page, signed.body)).status).toBe(201);
});

test("a payment passkey from another device is not offered to SPC", {
  timeout: 60_000,
}, async () => {
  const phone = await signer("internal");
  const laptop = await signer("usb", phone.userId);
  await laptop.addPlatformAuthenticator();
  expect(await laptop.page.evaluate("window.keelson.spcAvailable()")).toBe("available");
  expect((await passkeys(laptop.page)).passkeys.map((p) => p.payment)).toEqual([true, false]);
  const signed = await sign(laptop.page, mandateFor(laptop));
  expect(signed.type).toBe("webauthn.get");
  expect((await post(laptop.page, signed.body)).status).toBe(201);

  const again = await sign(phone.page, mandateFor(phone));
  expect(again.type).toBe("payment.get");
  expect((await post(phone.page, again.body)).status).toBe(201);
});

test("the mandate must name the signer", { timeout: 60_000 }, async () => {
  const s = await signer();
  const cases: [(m: Mandate) => void, number, string][] = [
    [(m) => (m.user.sub = "someone-else"), 403, "credential-not-owned"],
    [(m) => (m.user.cred.id = "c29tZW9uZS1lbHNl"), 403, "credential-not-owned"],
    [(m) => (m.user.cred.rp_id = "other.example"), 422, "invalid-mandate"],
    [(m) => (m.nbf = m.iat + 3600), 422, "invalid-mandate"],
  ];
  for (const [edit, status, slug] of cases) {
    const signed = await sign(s.page, mandateFor(s, edit));
    const res = await post(s.page, signed.body);
    expect(res.status, slug).toBe(status);
    expect(res.body.type).toBe(problemType(slug));
  }
});

test("a payload changed after signing is rejected", { timeout: 60_000 }, async () => {
  const s = await signer();
  const signed = await sign(s.page, mandateFor(s));
  const payloadSd = structuredClone(signed.body.payloadSd) as { policy: { version: string } };
  payloadSd.policy.version = "9.9.9";
  const res = await post(s.page, { ...signed.body, payloadSd });
  expect(res.status).toBe(401);
  expect(res.body.type).toBe(problemType("invalid-signature"));
});

test("concurrent submissions of one assertion store one mandate", { timeout: 60_000 }, async () => {
  const s = await signer();
  const m = mandateFor(s);
  const signed = await sign(s.page, m);
  const results = await Promise.all(Array.from({ length: 5 }, () => post(s.page, signed.body)));
  const statuses = results.map((r) => r.status).sort();
  expect(statuses).toEqual([201, 409, 409, 409, 409]);
  for (const r of results.filter((r) => r.status === 409)) {
    expect(r.body.type).toBe(problemType("mandate-exists"));
  }
  const rows = await testDb.query.mandates.findMany({ where: (t, { eq }) => eq(t.id, m.mid) });
  expect(rows).toHaveLength(1);
});

const capturePath = process.env.KEELSON_CAPTURE_WEBAUTHN;

// Real assertions for the cross-language verifier vectors; see packages/mandate/scripts.
test.runIf(capturePath)(
  "captures assertions for the verifier vectors",
  {
    timeout: 60_000,
  },
  async () => {
    const s = await signer();
    const [stored] = await userPasskeys(testDb, s.userId);
    const payment = await sign(s.page, mandateFor(s));
    const webauthn = await sign(s.page, mandateFor(s), { spc: false });
    const shownTotal = await sign(s.page, mandateFor(s), {
      shown: { total: { currency: "USD", value: "0.01" } },
    });
    const shownPayee = await sign(s.page, mandateFor(s), { shown: { payeeName: "Someone Else" } });
    expect([payment, webauthn, shownTotal, shownPayee].map((x) => x.type)).toEqual([
      "payment.get",
      "webauthn.get",
      "payment.get",
      "payment.get",
    ]);
    const challenge = JSON.parse(
      Buffer.from(webauthn.body.assertion.clientDataJSON, "base64url").toString(),
    ).challenge as string;
    await s.setUserVerified(false);
    const unverified = await s.page.evaluate(
      ([challenge, id]) =>
        (
          window as unknown as { keelson: { assert(...a: unknown[]): Promise<unknown> } }
        ).keelson.assert(challenge, id, "discouraged"),
      [challenge, s.credentialId] as const,
    );
    writeFileSync(
      capturePath as string,
      `${JSON.stringify(
        {
          origin: appOrigin,
          rpId: "keelson.finance",
          publicKey: stored?.publicKey,
          signed: {
            payment: payment.body,
            webauthn: webauthn.body,
            shownTotal: shownTotal.body,
            shownPayee: shownPayee.body,
            unverified: { ...webauthn.body, assertion: unverified },
          },
        },
        null,
        2,
      )}\n`,
    );
  },
);

test("only the app origin may call the API from a browser", { timeout: 60_000 }, async () => {
  const preflight = (origin: string) =>
    app.request("/v1/mandates", {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,idempotency-key",
      },
    });
  const allowed = await preflight(appOrigin);
  expect(allowed.status).toBe(204);
  expect(allowed.headers.get("access-control-allow-origin")).toBe(appOrigin);
  expect(allowed.headers.get("access-control-allow-credentials")).toBe("true");
  expect(allowed.headers.get("access-control-allow-headers")).toContain("idempotency-key");
  const denied = await preflight(evilOrigin);
  expect(denied.headers.get("access-control-allow-origin")).toBeNull();

  const s = await signer();
  await s.page.goto(`${evilOrigin}/test`);
  await s.page.waitForFunction("window.keelson !== undefined");
  const read = await s.page.evaluate(() =>
    (window as unknown as { keelson: { passkeys(): Promise<unknown> } }).keelson.passkeys().then(
      () => "read",
      (e: unknown) => String(e),
    ),
  );
  expect(read).toContain("Failed to fetch");
});
