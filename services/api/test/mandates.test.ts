import { randomBytes } from "node:crypto";
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
import { prepareSigning } from "@keelson/mandate";
import { signMandate } from "@keelson/mandate/browser";

const authClient = createAuthClient({ plugins: [passkeyClient()] });
const noEvidence = { merchantSignedCheckout: false, zkTlsFields: new Set() };
const toBase64Url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

window.keelson = {
  addPasskey: async () => {
    const { data, error } = await authClient.passkey.addPasskey({ name: "Test passkey" });
    return { data: data ?? null, error: error ?? null };
  },
  // The user confirms the card, then signs M with a passkey through SPC or plain WebAuthn.
  sign: async (mandate, credentialId, spc) => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const s = await prepareSigning(mandate, salt, noEvidence, "https://app.keelson.finance");
    const assertion = await signMandate(s.challenge, [credentialId], spc ? { spc: s.spc } : undefined);
    const type = JSON.parse(atob(assertion.clientDataJSON.replaceAll("-", "+").replaceAll("_", "/"))).type;
    return {
      type,
      body: {
        payloadSd: s.payloadSd,
        disclosures: s.disclosures,
        commitment: "0x" + s.cm.toString(16).padStart(64, "0"),
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
  post: async (body, key) => {
    const res = await fetch("/v1/mandates", {
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
    const res = await fetch("/v1/mandates/" + id);
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
// Served under the production RP ID: Chromium resolves both hosts to this server.
const appOrigin = `http://app.keelson.finance:${port}`;
const evilOrigin = `http://evil.example:${port}`;

const auth = createAuth(testDb, testAuthEnv(appOrigin, secret));
app = createApp({
  db: testDb,
  kv: testKv,
  log: pino({ level: "silent" }),
  auth,
  appOrigin,
  authenticate: authenticate(auth, appOrigin),
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
    '<!doctype html><title>Keelson</title><script type="module" src="/test/client.js"></script>',
  ),
);

const helpers = betterAuth({
  database: drizzleAdapter(testDb, { provider: "pg" }),
  secret,
  baseURL: appOrigin,
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
  // The full build: the headless shell has no Secure Payment Confirmation service.
  browser = await chromium.launch({
    channel: "chromium",
    args: [
      "--host-resolver-rules=MAP app.keelson.finance 127.0.0.1, MAP evil.example 127.0.0.1",
      `--unsafely-treat-insecure-origin-as-secure=${appOrigin},${evilOrigin}`,
    ],
  });
});

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
});

interface Signer {
  userId: string;
  page: Page;
  credentialId: string;
  jwk: { x: string; y: string };
  setUserVerified(verified: boolean): Promise<void>;
}

/** A new signed-in user on the app page, with one passkey on a virtual platform authenticator. */
async function signer(): Promise<Signer> {
  const { test: utils } = await helpers.$context;
  const user = await utils.saveUser(utils.createUser());
  const context = await browser.newContext({ baseURL: appOrigin });
  await context.addCookies(
    await utils.getCookies({ userId: user.id, domain: "app.keelson.finance" }),
  );
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });
  await cdp.send("Page.setSPCTransactionMode", { mode: "autoAccept" });
  await page.goto("/test");
  await page.waitForFunction("window.keelson !== undefined");
  const added = await page.evaluate<{ error: unknown }>("window.keelson.addPasskey()");
  expect(added.error).toBeNull();
  const [stored] = await userPasskeys(testDb, user.id);
  if (!stored) throw new Error("passkey was not stored");
  const key = decodeCredentialPublicKey(
    isoBase64URL.toBuffer(stored.publicKey, "base64"),
  ) as cose.COSEPublicKeyEC2;
  const coordinate = (bytes: Uint8Array | undefined) =>
    isoBase64URL.fromBuffer(new Uint8Array(bytes ?? []));
  return {
    userId: user.id,
    page,
    credentialId: stored.credentialID,
    jwk: { x: coordinate(key.get(cose.COSEKEYS.x)), y: coordinate(key.get(cose.COSEKEYS.y)) },
    setUserVerified: async (isUserVerified) => {
      await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified });
    },
  };
}

function mandateFor(s: Pick<Signer, "credentialId" | "jwk">): Mandate {
  const now = Math.floor(Date.now() / 1000);
  return parseMandate({
    ...structuredClone(demo),
    mid: ulid(),
    iat: now,
    nbf: now,
    exp: now + 7 * 86_400,
    user: {
      ...demo.user,
      cred: {
        id: s.credentialId,
        rp_id: "keelson.finance",
        jwk: { kty: "EC", crv: "P-256", ...s.jwk },
      },
    },
    agent: { ...demo.agent, operator: { ...demo.agent.operator, agent_id: String(operatorId) } },
  });
}

const sign = (page: Page, m: Mandate, credentialId: string, spc = true) =>
  page.evaluate(
    ([m, id, spc]) =>
      (window as unknown as { keelson: { sign(...a: unknown[]): Promise<Signed> } }).keelson.sign(
        m,
        id,
        spc,
      ),
    [m, credentialId, spc] as const,
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
  const signed = await sign(s.page, m, s.credentialId);
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
  const signed = await sign(s.page, mandateFor(s), s.credentialId, false);
  expect(signed.type).toBe("webauthn.get");
  expect((await post(s.page, signed.body)).status).toBe(201);
});

test("an assertion over a different challenge is rejected", { timeout: 60_000 }, async () => {
  const s = await signer();
  const a = await sign(s.page, mandateFor(s), s.credentialId);
  const b = await sign(s.page, mandateFor(s), s.credentialId);
  const res = await post(s.page, { ...b.body, assertion: a.body.assertion });
  expect(res.status).toBe(401);
  expect(res.body.type).toBe(problemType("invalid-signature"));
});

test("an assertion without user verification is rejected", { timeout: 60_000 }, async () => {
  const s = await signer();
  const signed = await sign(s.page, mandateFor(s), s.credentialId);
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
  expect(res.body.detail).toContain("User verification required");
});

test("a signature made on another origin is rejected", { timeout: 60_000 }, async () => {
  const s = await signer();
  const m = mandateFor(s);
  await s.page.goto(`${evilOrigin}/test`);
  await s.page.waitForFunction("window.keelson !== undefined");
  const signed = await sign(s.page, m, s.credentialId);
  expect(signed.type).toBe("payment.get");
  await s.page.goto(`${appOrigin}/test`);
  await s.page.waitForFunction("window.keelson !== undefined");
  const res = await post(s.page, signed.body);
  expect(res.status).toBe(401);
  expect(res.body.detail).toContain(evilOrigin);
});

test("another user's passkey cannot sign for the session user", { timeout: 60_000 }, async () => {
  const alice = await signer();
  const mallory = await signer();
  const signed = await sign(mallory.page, mandateFor(mallory), mallory.credentialId);
  const res = await post(alice.page, signed.body);
  expect(res.status).toBe(403);
  expect(res.body.type).toBe(problemType("credential-not-owned"));

  const named = await sign(
    alice.page,
    mandateFor({ ...alice, jwk: mallory.jwk }),
    alice.credentialId,
  );
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
  const signed = await sign(s.page, mandateFor(s), s.credentialId);
  const res = await post(s.page, { ...signed.body, commitment: `0x${"0".repeat(63)}1` });
  expect(res.status).toBe(422);
  expect(res.body.type).toBe(problemType("invalid-mandate"));
});

test("the server verifies and stores a signed mandate within budget", {
  timeout: 120_000,
}, async () => {
  const s = await signer();
  const bodies: Signed["body"][] = [];
  for (let i = 0; i < 50; i++)
    bodies.push((await sign(s.page, mandateFor(s), s.credentialId)).body);
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
