import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveOnPage } from "@keelson/paypal/testing";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";

/**
 * Judge Mode admits five sessions an hour per address, so one judge, with its cookies and its
 * passkeys, is kept for every live suite until the nightly reset.
 */
const DEFAULT_CACHE = process.env.KEELSON_LIVE_JUDGE ?? join(tmpdir(), "keelson-live-judge.json");
const CACHE_MS = 10 * 3_600_000;

interface Cached {
  at: number;
  storageState: Awaited<ReturnType<BrowserContext["storageState"]>>;
  credentials: unknown[];
}

export const APP_ORIGIN: string = process.env.KEELSON_APP_URL ?? "https://app.keelson.finance";
export const hasBuyer: boolean = Boolean(
  process.env.PAYPAL_SANDBOX_BUYER_EMAIL && process.env.PAYPAL_SANDBOX_BUYER_PASSWORD,
);

/**
 * A person at Keelson's app, in a real browser: signed in through Judge Mode (no email, no key)
 * with a virtual platform authenticator, so passkey prompts are answered as Face ID would.
 */
export interface User {
  page: Page;
  /** Allows a sign-in the CLI opened, on the consent page. */
  approveLogin(url: string): Promise<void>;
  /** Approves a mandate request with the passkey; with `hold`, also holds it on PayPal. */
  approveRequest(
    approvalUrl: string,
    o?: { matchNumber?: number | null; hold?: boolean },
  ): Promise<void>;
  denyRequest(approvalUrl: string): Promise<void>;
  api(method: string, path: string): Promise<{ status: number; body: unknown }>;
  /** Ends a mandate, as the user's Stop button does. */
  revokeMandate(mandateId: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * `cache` names the judge to reuse; a suite that buys takes its own, since what one user may buy
 * through the hosted operator is capped.
 */
export async function judge(o: { cache?: string } = {}): Promise<User> {
  const CACHE = o.cache ? join(tmpdir(), `keelson-live-judge-${o.cache}.json`) : DEFAULT_CACHE;
  const browser: Browser = await chromium.launch({
    headless: process.env.PLAYWRIGHT_HEADED !== "1",
  });
  const cached = await readFile(CACHE, "utf8")
    .then((t) => JSON.parse(t) as Cached)
    .catch(() => undefined);
  const reuse = cached && Date.now() - cached.at < CACHE_MS ? cached : undefined;
  let at = reuse?.at;
  const context: BrowserContext = await browser.newContext({
    locale: "en-US",
    ...(reuse ? { storageState: reuse.storageState } : {}),
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
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
  for (const credential of reuse?.credentials ?? []) {
    await cdp.send("WebAuthn.addCredential", {
      authenticatorId,
      credential: credential as never,
    });
  }
  const save = async () => {
    at ??= Date.now();
    const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
    const entry: Cached = {
      at: at ?? Date.now(),
      storageState: await context.storageState(),
      credentials,
    };
    await writeFile(CACHE, JSON.stringify(entry), { mode: 0o600 });
  };
  // The nightly reset ends a judge's session before the cache expires; start a new judge then.
  const alive =
    reuse &&
    (await page.request
      .get(`${process.env.KEELSON_API_URL ?? "https://api.keelson.finance"}/v1/passkeys`, {
        headers: { origin: APP_ORIGIN },
      })
      .then((r) => r.status() !== 401)
      .catch(() => false));
  if (!alive) {
    await context.clearCookies();
    await page.goto(`${APP_ORIGIN}/judge/`);
    const started = page.waitForResponse((r) => r.url().endsWith("/v1/judge/sessions"));
    await page.getByRole("button", { name: "Start Judge Mode" }).click();
    const res = await started;
    if (res.status() !== 201) {
      const problem = (await res.json().catch(() => ({}))) as { title?: string; detail?: string };
      await browser.close();
      throw new Error(
        `Judge Mode refused (${res.status()}): ${problem.title}. ${problem.detail ?? ""}`,
      );
    }
    await page.getByRole("heading", { level: 1, name: "The mandate" }).waitFor();
    await save();
  }

  const openRequest = async (approvalUrl: string, matchNumber?: number | null) => {
    await page.goto(approvalUrl);
    if (matchNumber) await page.getByRole("button", { name: String(matchNumber) }).click();
  };

  /** Calls Keelson's API from the app's page, with the user's session. */
  const api = async (method: string, path: string): Promise<{ status: number; body: unknown }> => {
    if (!page.url().startsWith(APP_ORIGIN)) await page.goto(`${APP_ORIGIN}/`);
    const base = process.env.KEELSON_API_URL ?? "https://api.keelson.finance";
    return page.evaluate(
      async ([url, m, key]) => {
        const res = await fetch(url as string, {
          method: m as string,
          credentials: "include",
          headers:
            m === "POST"
              ? { "content-type": "application/json", "idempotency-key": key as string }
              : {},
          ...(m === "POST" ? { body: "{}" } : {}),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      },
      [`${base}${path}`, method, crypto.randomUUID()],
    );
  };

  return {
    page,
    api,
    async approveLogin(url) {
      const callback = /^http:\/\/127\.0\.0\.1:\d+\/callback/;
      await page.goto(url);
      // A client the user already allowed goes straight back to the CLI.
      if (!callback.test(page.url())) {
        await page.getByRole("button", { name: /^Allow/ }).click();
        await page.waitForURL(callback);
      }
    },
    async approveRequest(approvalUrl, o = {}) {
      await openRequest(approvalUrl, o.matchNumber);
      // A user without a passkey makes one first, then signs; each step is a button to press.
      const approved = page.getByRole("heading", { level: 1, name: "Approved" });
      const steps = [
        page.getByRole("button", { name: /^Approve .* with passkey$/ }),
        page.getByRole("button", { name: "Create passkey" }),
        page.getByRole("button", { name: /^Sign: allow up to / }),
      ];
      const until = Date.now() + 120_000;
      while (!(await approved.isVisible())) {
        if (Date.now() > until)
          throw new Error(`not approved: ${await page.locator("main").innerText()}`);
        const step = await Promise.any(
          steps.map(async (b) => {
            await b.waitFor({ timeout: 5_000 });
            return b;
          }),
        ).catch(() => undefined);
        if (step && (await step.isEnabled())) await step.click();
        else await page.waitForTimeout(500);
      }
      await save();
      if (!o.hold) return;
      await page.getByRole("link", { name: /^Hold .* on PayPal$/ }).click();
      await page.locator("paypal-button").waitFor();
      const popup = context.waitForEvent("page", { timeout: 20_000 });
      await page.locator("paypal-button").click();
      const paypal = await popup;
      paypal.setDefaultTimeout(60_000);
      await paypal.waitForLoadState();
      await approveOnPage(paypal);
      await page.getByRole("heading", { name: "Your agent is live" }).waitFor({ timeout: 90_000 });
    },
    async denyRequest(approvalUrl) {
      await openRequest(approvalUrl);
      await page.getByRole("button", { name: /^(Reject|Decline)$/ }).click();
      await page.getByRole("heading", { level: 1, name: /^(Declined|Rejected)$/ }).waitFor();
    },
    async revokeMandate(mandateId) {
      if (!page.url().startsWith(APP_ORIGIN)) await page.goto(`${APP_ORIGIN}/`);
      const api = process.env.KEELSON_API_URL ?? "https://api.keelson.finance";
      const status = await page.evaluate(
        async ([url, key]) =>
          (
            await fetch(url as string, {
              method: "POST",
              credentials: "include",
              headers: { "content-type": "application/json", "idempotency-key": key as string },
              body: "{}",
            })
          ).status,
        [`${api}/v1/mandates/${mandateId}/revoke`, crypto.randomUUID()],
      );
      if (status >= 300) throw new Error(`revoking ${mandateId}: HTTP ${status}`);
    },
    async close() {
      await save().catch(() => {});
      await context.close();
      await browser.close();
    },
  };
}
