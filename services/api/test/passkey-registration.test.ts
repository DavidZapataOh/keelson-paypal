import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { serve } from "@hono/node-server";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { cose, decodeCredentialPublicKey } from "@simplewebauthn/server/helpers";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { build } from "esbuild";
import { pino } from "pino";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth.ts";
import { authenticate } from "../src/middleware/auth.ts";
import { userPasskeys } from "../src/passkeys.ts";
import { testAuthEnv, testDb, testKv } from "./setup.ts";

const pageScript = `
import { createAuthClient } from "better-auth/client";
import { passkeyClient } from "@better-auth/passkey/client";

const authClient = createAuthClient({ plugins: [passkeyClient()] });
const result = ({ data, error }) => ({ data: data ?? null, error: error ?? null });

window.keelson = {
  addPasskey: async () => result(await authClient.passkey.addPasskey({ name: "Test passkey" })),
  signInWithPasskey: async () => result(await authClient.signIn.passkey({ autoFill: false })),
  signOut: async () => result(await authClient.signOut()),
  getSession: async () => result(await authClient.getSession()),
  // Skips the client library so the authenticator can be offered an algorithm the server never offers.
  registerWithAlgorithm: async (alg) => {
    const options = await (await fetch("/api/auth/passkey/generate-register-options")).json();
    const credential = await navigator.credentials.create({
      publicKey: PublicKeyCredential.parseCreationOptionsFromJSON({
        ...options,
        pubKeyCredParams: [{ type: "public-key", alg }],
      }),
    });
    const res = await fetch("/api/auth/passkey/verify-registration", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: credential.toJSON() }),
    });
    return { status: res.status, body: await res.json() };
  },
};
`;

interface Result<T> {
  data: T | null;
  error: { message?: string; status?: number } | null;
}
interface SessionData {
  user: { id: string };
  session: { userId: string };
}

const secret = randomBytes(32).toString("base64url");
let app!: OpenAPIHono;
const server = serve({ fetch: (req) => app.fetch(req), port: 0, hostname: "localhost" });
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const baseURL = `http://localhost:${(server.address() as AddressInfo).port}`;

const auth = createAuth(testDb, { ...testAuthEnv(baseURL, secret), PASSKEY_RP_ID: "localhost" });
app = createApp({
  db: testDb,
  kv: testKv,
  log: pino({ level: "silent" }),
  auth,
  appOrigin: baseURL,
  authenticate: authenticate(auth, baseURL),
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
  baseURL,
  plugins: [testUtils()],
});

let browser!: Browser;
let page!: Page;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
});

const call = <T>(name: string) => page.evaluate<Result<T>>(`window.keelson.${name}()`);

/** Opens the test page as a new signed-in user, with a virtual platform authenticator attached. */
async function signedInPage() {
  const { test: utils } = await helpers.$context;
  const user = await utils.saveUser(utils.createUser());
  const context: BrowserContext = await browser.newContext({ baseURL });
  await context.addCookies(await utils.getCookies({ userId: user.id, domain: "localhost" }));
  page = await context.newPage();
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
  await page.goto("/test");
  await page.waitForFunction("window.keelson !== undefined");
  return { user, cdp, authenticatorId };
}

test("a signed-in user registers a passkey and signs in with it", { timeout: 60_000 }, async () => {
  const { user, cdp, authenticatorId } = await signedInPage();

  const added = await call<{ id: string }>("addPasskey");
  expect(added.error).toBeNull();

  expect((await call("signOut")).error).toBeNull();
  expect((await call<SessionData>("getSession")).data).toBeNull();

  const signedIn = await call<SessionData>("signInWithPasskey");
  expect(signedIn.error).toBeNull();
  const session = await call<SessionData>("getSession");
  expect(session.data?.user.id).toBe(user.id);

  const [credential, ...others] = (await cdp.send("WebAuthn.getCredentials", { authenticatorId }))
    .credentials;
  expect(others).toHaveLength(0);
  expect(credential?.isResidentCredential).toBe(true);

  const passkeys = await userPasskeys(testDb, user.id);
  expect(passkeys).toHaveLength(1);
  const [stored] = passkeys;
  expect(Buffer.from(stored?.credentialID ?? "", "base64url")).toEqual(
    Buffer.from(credential?.credentialId ?? "", "base64"),
  );
  const publicKey = decodeCredentialPublicKey(Buffer.from(stored?.publicKey ?? "", "base64"));
  expect(publicKey.get(cose.COSEKEYS.alg)).toBe(cose.COSEALG.ES256);
  expect(stored?.counter).toBeGreaterThanOrEqual(0);
  expect(stored?.transports).toContain("internal");
});

test("registration rejects passkeys that are not ES256", { timeout: 60_000 }, async () => {
  const { user, cdp, authenticatorId } = await signedInPage();
  for (const alg of [cose.COSEALG.EdDSA, cose.COSEALG.RS256]) {
    const res = await page.evaluate<{ status: number; body: { message?: string } }>(
      `window.keelson.registerWithAlgorithm(${alg})`,
    );
    expect(res.status, `alg ${alg}`).toBe(400);
    expect(res.body.message).toBe("Passkeys must use ES256.");
  }
  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  expect(credentials).toHaveLength(2);
  expect(await userPasskeys(testDb, user.id)).toHaveLength(0);

  const control = await page.evaluate<{ status: number }>(
    `window.keelson.registerWithAlgorithm(${cose.COSEALG.ES256})`,
  );
  expect(control.status).toBe(200);
  expect(await userPasskeys(testDb, user.id)).toHaveLength(1);
});
