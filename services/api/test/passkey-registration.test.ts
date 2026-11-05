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
let context!: BrowserContext;
let page!: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  context = await browser.newContext({ baseURL });
});

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
});

const call = <T>(name: string) => page.evaluate<Result<T>>(`window.keelson.${name}()`);

test("a signed-in user registers a passkey and signs in with it", { timeout: 60_000 }, async () => {
  const { test: utils } = await helpers.$context;
  const user = await utils.saveUser(utils.createUser());
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
