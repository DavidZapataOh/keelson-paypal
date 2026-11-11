import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import demo from "../../../../packages/mandate/test/fixtures/demo-mandate.json" with {
  type: "json",
};

const out = fileURLToPath(new URL("../../out", import.meta.url));
const API = "https://api.keelson.finance";
const APP = "https://app.keelson.finance";
const HOST = "https://agents.example.com";
const EVIL = "https://evil.example.net";
const REF = "01M7EMBEDREF00000000000000";
const URL_ = `${API}/embed/approve?r=${REF}#t=ket_${"a".repeat(43)}`;
const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
};

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const REASON =
  "I am the shopping agent on this demo platform. You asked me to find and buy running shoes under $120 at RunFast; I compare the pairs, then check out only what you approve here.";

const view = (state = "PENDING", mandateId: string | null = null, signer: unknown = null) => ({
  ref: REF,
  origin: HOST,
  signer,
  matchNumber: 42,
  request: {
    code: "BCDF-GHJK",
    kind: "connect",
    state,
    name: "Shopping agent",
    reason: REASON,
    agent: {
      agentId: "4242",
      operator: "Errand Labs",
      bond: { asset: "PYUSD", min: 50_000_000, vault: "0x1" },
    },
    limits: {
      currency: "USD",
      perPurchaseMinor: "6000",
      totalMinor: "12000",
      askAboveMinor: "4000",
      merchants: [{ id: "mrc_runfast", name: "RunFast" }],
      until: later(7 * 86_400_000),
    },
    parent: null,
    mandateId,
    expiresAt: later(14 * 60_000),
  },
});

async function asset(path: string): Promise<string | undefined> {
  for (const candidate of [join(out, path), join(out, path, "index.html")]) {
    if ((await stat(candidate).catch(() => undefined))?.isFile()) return candidate;
  }
  return undefined;
}

interface Api {
  state: string;
  mandateId: string | null;
  opened: number;
  declined: number;
  /** Who the frame signs for, once it signed in or a Keelson window linked the user. */
  signer: {
    passkeys: { credentialId: string; payment: boolean }[];
    credentialId: string | null;
  } | null;
  /** The client data of every ceremony the frame answered, by route. */
  ceremonies: Record<string, Record<string, unknown>>;
  /** The passkey the frame created. */
  jwk?: { kty: "EC"; crv: "P-256"; x: string; y: string };
  /** The mandate the frame stored. */
  stored?: { payloadSd: Record<string, unknown>; assertion: { credentialId: string } };
}

/** A P-256 passkey for the virtual authenticator, and its public JWK for the mandate. */
function passkeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  return {
    id: randomBytes(16).toString("base64url"),
    pkcs8: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    jwk: { kty: "EC" as const, crv: "P-256" as const, x: jwk.x, y: jwk.y },
  };
}

/** The draft the API returns for the platform's embed, naming `cred`. */
function draftFor(cred: { id: string; jwk: unknown }) {
  const now = Math.floor(Date.now() / 1000);
  return {
    mandateDraft: {
      ...structuredClone(demo),
      mid: "01M7MANDATE000000000000000",
      iat: now,
      nbf: now,
      exp: now + 86_400,
      user: { ...demo.user, cred: { id: cred.id, rp_id: "keelson.finance", jwk: cred.jwk } },
      embed: { top_origin: HOST },
    },
    card: { rows: [] },
    ambiguous: [],
    check: { status: "skipped", discrepancies: null },
  };
}

const clientDataOf = (body: { response?: { clientDataJSON?: string } } | undefined) =>
  JSON.parse(
    Buffer.from(body?.response?.clientDataJSON ?? "", "base64url").toString("utf8"),
  ) as Record<string, unknown>;

/** The Permissions-Policy the production approval page sends. */
const PAGE_PERMISSIONS =
  "publickey-credentials-get=(self), publickey-credentials-create=(self), payment=(self), camera=(), microphone=(), geolocation=(), clipboard-read=()";

/**
 * A browser where `HOST` (or `EVIL`) is an agent platform page with the SDK, Keelson's API serves
 * the exported embed page with `frame-ancestors` for `HOST` only, and the app serves the export.
 */
async function world(
  opts: {
    hostOrigin?: string;
    overlay?: boolean;
    ancestors?: string;
    /** The host page's own Permissions-Policy: what it can delegate to Keelson's frame. */
    hostPermissions?: string;
    /** A passkey already on this device's authenticator. */
    passkey?: ReturnType<typeof passkeyPair>;
  } = {},
) {
  const api: Api = {
    state: "PENDING",
    mandateId: null,
    opened: 0,
    declined: 0,
    signer: null,
    ceremonies: {},
  };
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const hostOrigin = opts.hostOrigin ?? HOST;
  const hostPage = `<!doctype html><html lang="en"><head><title>Host</title>
<script src="${APP}/embed/v1.js"></script></head><body style="margin:0;padding:24px;font-family:sans-serif">
<main><h1>Agent platform</h1><div id="slot" style="width:440px;position:relative"></div>
${opts.overlay ? '<div style="position:fixed;inset:0;background:rgb(255 255 255/.01)"></div>' : ""}
<iframe id="evil" title="Other" src="${EVIL}/forge"></iframe></main>
<script>
window.events = [];
window.mounted = Keelson.mount(document.getElementById("slot"), { url: ${JSON.stringify(URL_)}, onEvent: (e) => window.events.push(e) });
</script></body></html>`;
  const forge = `<!doctype html><html lang="en"><head><title>Forge</title></head><body><script>
setInterval(() => parent.postMessage({ source: "keelson", version: 1, type: "approved", requestId: "x", mandateId: "forged" }, "*"), 200);
</script></body></html>`;
  await context.route(`${hostOrigin}/`, (r) =>
    r.fulfill({
      contentType: "text/html",
      body: hostPage,
      // A host delegates the features to Keelson's frame and keeps them itself: a frame gets a
      // feature only where its parent has it.
      headers: {
        "permissions-policy":
          opts.hostPermissions ??
          `publickey-credentials-get=(self "${API}"), publickey-credentials-create=(self "${API}"), payment=(self "${API}")`,
      },
    }),
  );
  await context.route(`${EVIL}/forge`, (r) => r.fulfill({ contentType: "text/html", body: forge }));
  const serve = async (r: Parameters<Parameters<BrowserContext["route"]>[1]>[0], path: string) => {
    const file = await asset(decodeURIComponent(path));
    if (!file) return r.fulfill({ status: 404 });
    return r.fulfill({
      contentType: TYPES[extname(file)] ?? "application/octet-stream",
      body: await readFile(file),
      headers: { "access-control-allow-origin": "*" },
    });
  };
  await context.route(`${APP}/**`, (r) => serve(r, new URL(r.request().url()).pathname));
  await context.route(`${API}/**`, async (r) => {
    const req = r.request();
    const url = new URL(req.url());
    if (url.pathname === "/embed/approve") {
      const file = (await asset("/embed/approve")) as string;
      return r.fulfill({
        contentType: "text/html",
        body: await readFile(file),
        headers: {
          "content-security-policy": `frame-ancestors ${opts.ancestors ?? HOST}`,
          "permissions-policy": PAGE_PERMISSIONS,
        },
      });
    }
    if (url.pathname.startsWith("/_next/")) return serve(r, url.pathname);
    if (!url.pathname.startsWith("/v1/")) return r.fulfill({ status: 404 });
    // The frame never sends cookies.
    expect(await req.headerValue("cookie")).toBeNull();
    if (url.pathname === "/v1/embed/sessions") {
      api.opened += 1;
      if (api.opened > 1) {
        return r.fulfill({ status: 401, contentType: "application/problem+json", body: "{}" });
      }
      return r.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ session: `kes_${"b".repeat(43)}`, embed: view() }),
      });
    }
    if ((await req.headerValue("keelson-embed")) !== `kes_${"b".repeat(43)}`) {
      return r.fulfill({ status: 401, contentType: "application/problem+json", body: "{}" });
    }
    if (url.pathname === "/v1/embed/request") {
      return r.fulfill({
        contentType: "application/json",
        body: JSON.stringify(view(api.state, api.mandateId, api.signer)),
      });
    }
    const json = (body: unknown, status = 200) =>
      r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    const posted = req.postDataJSON() as Record<string, unknown> | undefined;
    if (url.pathname === "/v1/embed/sign-in/options") {
      return json({
        challenge: randomBytes(32).toString("base64url"),
        rpId: "keelson.finance",
        userVerification: "required",
        timeout: 60_000,
        allowCredentials: [],
      });
    }
    if (url.pathname === "/v1/embed/sign-in") {
      api.ceremonies.signIn = clientDataOf(posted as never);
      api.signer = {
        passkeys: [{ credentialId: String(posted?.id), payment: false }],
        credentialId: String(posted?.id),
      };
      return json(api.signer);
    }
    if (url.pathname === "/v1/embed/links") {
      return json({ nonce: `kel_${"c".repeat(43)}`, expires_in: 600 }, 201);
    }
    if (url.pathname === "/v1/embed/links/claim") {
      if (posted?.grant !== `keg_${"d".repeat(43)}`) return json({}, 401);
      api.signer = { passkeys: [], credentialId: null };
      return json(api.signer);
    }
    if (url.pathname === "/v1/embed/passkeys/options") {
      return json({
        challenge: randomBytes(32).toString("base64url"),
        rp: { id: "keelson.finance", name: "Keelson" },
        user: { id: randomBytes(16).toString("base64url"), name: "Ada", displayName: "Ada" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        timeout: 60_000,
        attestation: "none",
        excludeCredentials: [],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
      });
    }
    if (url.pathname === "/v1/embed/passkeys") {
      api.ceremonies.create = clientDataOf(posted as never);
      const response = posted?.response as { publicKey?: string } | undefined;
      const spki = Buffer.from(response?.publicKey ?? "", "base64url");
      // The last 64 bytes of a P-256 SPKI are x and y.
      const point = spki.subarray(spki.length - 64);
      const id = String(posted?.id);
      api.signer = { passkeys: [{ credentialId: id, payment: false }], credentialId: id };
      api.jwk = {
        kty: "EC",
        crv: "P-256",
        x: point.subarray(0, 32).toString("base64url"),
        y: point.subarray(32).toString("base64url"),
      };
      return json(api.signer, 201);
    }
    if (url.pathname === "/v1/embed/draft") {
      const id = api.signer?.credentialId ?? "";
      return json(draftFor({ id, jwk: api.jwk ?? opts.passkey?.jwk }));
    }
    if (url.pathname === "/v1/embed/mandates") {
      const body = posted as unknown as NonNullable<Api["stored"]> & {
        assertion: { clientDataJSON: string };
      };
      api.stored = body;
      api.ceremonies.sign = clientDataOf({ response: body.assertion });
      api.state = "APPROVED";
      api.mandateId = "01M7MANDATE000000000000000";
      return json({ id: api.mandateId, state: "ACTIVE" }, 201);
    }
    if (url.pathname === "/v1/embed/deny") {
      api.declined += 1;
      api.state = "DENIED";
      return r.fulfill({ contentType: "application/json", body: JSON.stringify(view("DENIED")) });
    }
    return r.abort("connectionrefused");
  });
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
      automaticPresenceSimulation: true,
    },
  });
  if (opts.passkey) {
    await cdp.send("WebAuthn.addCredential", {
      authenticatorId,
      credential: {
        credentialId: Buffer.from(opts.passkey.id, "base64url").toString("base64"),
        isResidentCredential: true,
        rpId: "keelson.finance",
        privateKey: opts.passkey.pkcs8,
        userHandle: randomBytes(16).toString("base64"),
        signCount: 0,
      },
    });
  }
  await page.goto(`${hostOrigin}/`);
  return { context, page, api };
}

const frameOf = (page: Page) => page.frameLocator("#slot iframe");
/** Waits until the SDK has sized the frame to its whole content, so nothing inside it scrolls. */
const settled = (page: Page) =>
  expect
    .poll(() =>
      page
        .frameLocator("#slot iframe")
        .locator("html")
        .evaluate((el) => el.scrollHeight - innerHeight),
    )
    .toBe(0);
const events = (page: Page) =>
  page.evaluate(() => (window as unknown as { events: { type: string }[] }).events);
const typesOf = async (page: Page) => (await events(page)).map((e) => e.type);

async function shot(page: Page, name: string) {
  const dir = process.env.KEELSON_SHOTS;
  if (dir) await page.screenshot({ path: join(dir, `embed-${name}.png`), fullPage: true });
}

describe("the embedded approval", () => {
  test("opens with the token once, tells its host ready and its height, and ignores forgeries", async () => {
    const { context, page, api } = await world();
    const frame = frameOf(page);
    await frame
      .getByRole("heading", { name: /Shopping agent wants to spend up to \$120\.00/ })
      .waitFor();
    await expect.poll(() => typesOf(page)).toContain("ready");
    await expect.poll(() => typesOf(page)).toContain("resize");
    // The SDK sized the frame to its content: no inner scrollbar.
    await settled(page);
    // The other frame's forged "approved" never reaches the host.
    await page.waitForTimeout(800);
    expect(await typesOf(page)).not.toContain("approved");
    expect(api.opened).toBe(1);
    await frame.getByText("on agents.example.com").waitFor();
    await frame.getByText("Errand Labs", { exact: true }).waitFor();
    await frame.getByText(/Who answers/).waitFor();
    await shot(page, "review");
    const { violations } = await new AxeBuilder({ page })
      .include("#slot")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(violations.map((v) => v.id)).toEqual([]);
    await context.close();
  });

  test("Allow waits until it has been visible; signing in and signing happen in the frame, with no window", async () => {
    const passkey = passkeyPair();
    const { context, page, api } = await world({ passkey });
    const frame = frameOf(page);
    const allow = frame.getByRole("button", { name: "Allow $120.00" });
    await allow.waitFor();
    expect(await allow.getAttribute("aria-disabled")).toBe("true");
    await frame.getByLabel("Most in total").fill("9000");
    const lowered = frame.getByRole("button", { name: "Allow $90.00" });
    await lowered.scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    await expect.poll(() => lowered.getAttribute("aria-disabled")).toBe("false");
    let windows = 0;
    context.on("page", () => {
      windows += 1;
    });
    await lowered.click();
    // The passkey that signs in tells who signs; the mandate then drafts for the limits chosen.
    const sign = frame.getByRole("button", { name: "Sign $90.00 with passkey" });
    await sign.waitFor();
    expect(api.ceremonies.signIn).toMatchObject({
      type: "webauthn.get",
      origin: API,
      crossOrigin: true,
      topOrigin: HOST,
    });
    await expect.poll(() => sign.getAttribute("aria-disabled"), { timeout: 20_000 }).toBe("false");
    await shot(page, "confirm");
    await sign.click();
    await frame.getByRole("heading", { name: "Approved" }).waitFor({ timeout: 20_000 });
    expect(api.ceremonies.sign).toMatchObject({
      type: "webauthn.get",
      origin: API,
      crossOrigin: true,
      topOrigin: HOST,
    });
    expect(api.stored?.payloadSd.embed).toEqual({ top_origin: HOST });
    expect(api.stored?.assertion.credentialId).toBe(passkey.id);
    await expect
      .poll(() => events(page))
      .toContainEqual({
        source: "keelson",
        version: 1,
        type: "approved",
        requestId: REF,
        mandateId: "01M7MANDATE000000000000000",
      });
    expect(windows).toBe(0);
    await shot(page, "approved-in-frame");
    await context.close();
  });

  test("a new user signs in once in a Keelson window, then creates the passkey and signs in the frame", async () => {
    const { context, page, api } = await world();
    const frame = frameOf(page);
    await settled(page);
    const link = frame.getByRole("button", { name: /New to Keelson/ });
    await link.scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    const popupWaiter = context.waitForEvent("page");
    await link.click();
    const popup = await popupWaiter;
    await expect.poll(() => popup.url()).toContain(`${APP}/connect/`);
    const opened = new URL(popup.url());
    expect(Object.fromEntries(opened.searchParams)).toMatchObject({
      c: "BCDF-GHJK",
      embed: REF,
      via: "frame",
      link: `kel_${"c".repeat(43)}`,
    });
    await frame.getByText("Sign in to Keelson in the window, then come back here").waitFor();
    // A grant from any page other than the window this frame opened is ignored.
    await page.evaluate(
      ([api, grant]) =>
        (document.querySelector("#slot iframe") as HTMLIFrameElement).contentWindow?.postMessage(
          { type: "keelson:linked", grant },
          api,
        ),
      [API, `keg_${"d".repeat(43)}`] as const,
    );
    await page.waitForTimeout(800);
    expect(api.signer).toBeNull();
    // The user signs in there and confirms; the window hands the grant to its opener, this frame.
    await popup.evaluate(
      ([api, grant]) => window.opener.postMessage({ type: "keelson:linked", grant }, api),
      [API, `keg_${"d".repeat(43)}`] as const,
    );
    const create = frame.getByRole("button", { name: "Create passkey" });
    await create.waitFor({ timeout: 6_000 });
    // It arms, like Allow, only once seen whole.
    await create.scrollIntoViewIfNeeded();
    await expect
      .poll(() => create.getAttribute("aria-disabled"), { timeout: 10_000 })
      .toBe("false");
    await shot(page, "create");
    await create.click();
    const sign = frame.getByRole("button", { name: "Sign $120.00 with passkey" });
    await sign.waitFor();
    expect(api.ceremonies.create).toMatchObject({
      type: "webauthn.create",
      origin: API,
      crossOrigin: true,
      topOrigin: HOST,
    });
    await expect.poll(() => sign.getAttribute("aria-disabled"), { timeout: 20_000 }).toBe("false");
    await sign.click();
    await frame.getByRole("heading", { name: "Approved" }).waitFor({ timeout: 20_000 });
    expect(api.ceremonies.sign).toMatchObject({ crossOrigin: true, topOrigin: HOST });
    await context.close();
  });

  test("where the page cannot create a passkey in a frame, the Keelson window finishes", async () => {
    const { context, page } = await world({
      hostPermissions: `publickey-credentials-get=("${API}"), publickey-credentials-create=()`,
    });
    const frame = frameOf(page);
    await settled(page);
    const link = frame.getByRole("button", { name: /New to Keelson/ });
    await link.scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    const first = context.waitForEvent("page");
    await link.click();
    const window_ = await first;
    await expect.poll(() => window_.url()).toContain(`${APP}/connect/`);
    await window_.evaluate(
      ([api, grant]) => window.opener.postMessage({ type: "keelson:linked", grant }, api),
      [API, `keg_${"d".repeat(43)}`] as const,
    );
    const create = frame.getByRole("button", { name: "Create passkey" });
    await expect.poll(() => create.getAttribute("aria-disabled"), { timeout: 6_000 }).toBe("false");
    await create.click();
    await frame.getByText(/cannot create a passkey here/).waitFor();
    const second = context.waitForEvent("page");
    await frame.getByRole("button", { name: "Continue in Keelson" }).click();
    const signing = new URL((await second).url());
    expect(`${signing.origin}${signing.pathname}`).toBe(`${APP}/connect/`);
    expect(signing.searchParams.get("link")).toBeNull();
    await shot(page, "create-elsewhere");
    await context.close();
  });

  test("where the page delegates no passkey to the frame, Allow opens Keelson's own window with the lowered limits", async () => {
    const { context, page, api } = await world({
      hostPermissions: "publickey-credentials-get=(), publickey-credentials-create=(), payment=()",
    });
    const frame = frameOf(page);
    const allow = frame.getByRole("button", { name: "Allow $120.00" });
    await allow.waitFor();
    expect(await allow.getAttribute("aria-disabled")).toBe("true");
    await frame.getByLabel("Most in total").fill("9000");
    // It arms only once the user can see it.
    await frame.getByRole("button", { name: "Allow $90.00" }).scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    await frame.getByRole("button", { name: "Allow $90.00" }).waitFor();
    await expect
      .poll(() => frame.getByRole("button", { name: "Allow $90.00" }).getAttribute("aria-disabled"))
      .toBe("false");
    const popupWaiter = context.waitForEvent("page");
    await frame.getByRole("button", { name: "Allow $90.00" }).click();
    const popup = await popupWaiter;
    const signing = new URL(popup.url());
    expect(signing.origin).toBe(APP);
    expect(signing.pathname).toBe("/connect/");
    expect(Object.fromEntries(signing.searchParams)).toMatchObject({
      c: "BCDF-GHJK",
      embed: REF,
      via: "frame",
      tt: "9000",
      pp: "6000",
    });
    await frame.getByText("Confirm in the Keelson window").waitFor();
    await shot(page, "waiting");
    // The user signs there; the frame reads the answer from Keelson, not from any message.
    api.state = "APPROVED";
    api.mandateId = "01M7MANDATE000000000000000";
    await frame.getByRole("heading", { name: "Approved" }).waitFor({ timeout: 6_000 });
    await expect
      .poll(() => events(page))
      .toContainEqual({
        source: "keelson",
        version: 1,
        type: "approved",
        requestId: REF,
        mandateId: "01M7MANDATE000000000000000",
      });
    await shot(page, "approved");
    await context.close();
  });

  test("a covered frame never arms its Allow button", async () => {
    const { context, page } = await world({ overlay: true });
    const allow = frameOf(page).getByRole("button", { name: "Allow $120.00" });
    await allow.waitFor();
    // Intersection Observer v2 sees the cover; this browser must support it for the test to mean anything.
    expect(await allow.evaluate(() => "isVisible" in IntersectionObserverEntry.prototype)).toBe(
      true,
    );
    await settled(page);
    await allow.scrollIntoViewIfNeeded();
    await page.waitForTimeout(2_000);
    expect(await allow.getAttribute("aria-disabled")).toBe("true");
    await context.close();
  });

  test("declining tells the host, and nothing is signed", async () => {
    const { context, page, api } = await world();
    const frame = frameOf(page);
    await settled(page);
    const reject = frame.getByRole("button", { name: "Reject" });
    await reject.scrollIntoViewIfNeeded();
    // Chromium drops clicks on a cross-origin frame that has just moved.
    await page.waitForTimeout(600);
    await reject.click();
    await frame.getByRole("heading", { name: "Declined" }).waitFor();
    expect(api.declined).toBe(1);
    await expect.poll(() => typesOf(page)).toContain("declined");
    await shot(page, "declined");
    await context.close();
  });

  test("framed by a page other than the platform's, it shows nothing", async () => {
    // `frame-ancestors` normally stops this; the page checks its ancestor too.
    const { context, page } = await world({ hostOrigin: EVIL, ancestors: "*" });
    const frame = frameOf(page);
    await frame.getByRole("heading", { name: "Open this from the agent's app" }).waitFor();
    expect(await frame.getByRole("button", { name: /Allow/ }).count()).toBe(0);
    expect(await typesOf(page)).not.toContain("ready");
    await context.close();
  });
});
