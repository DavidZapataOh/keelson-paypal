import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveOnPage } from "@keelson/paypal/testing";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";

/**
 * Judge Mode admits five sessions an hour per address, so one judge, with its cookies and its
 * passkeys, is kept for every live suite until the nightly reset.
 */
const CACHE = process.env.KEELSON_LIVE_JUDGE ?? join(tmpdir(), "keelson-live-judge.json");
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
  close(): Promise<void>;
}

export async function judge(): Promise<User> {
  const browser: Browser = await chromium.launch({
    headless: process.env.PLAYWRIGHT_HEADED !== "1",
  });
  const cached = await readFile(CACHE, "utf8")
    .then((t) => JSON.parse(t) as Cached)
    .catch(() => undefined);
  const reuse = cached && Date.now() - cached.at < CACHE_MS ? cached : undefined;
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
    const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
    const entry: Cached = {
      at: reuse?.at ?? Date.now(),
      storageState: await context.storageState(),
      credentials,
    };
    await writeFile(CACHE, JSON.stringify(entry), { mode: 0o600 });
  };
  if (!reuse) {
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

  const createPasskeyIfAsked = async () => {
    const create = page.getByRole("button", { name: "Create passkey" });
    if (await create.isVisible().catch(() => false)) await create.click();
  };

  const openRequest = async (approvalUrl: string, matchNumber?: number | null) => {
    await page.goto(approvalUrl);
    if (matchNumber) await page.getByRole("button", { name: String(matchNumber) }).click();
  };

  return {
    page,
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
      const approve = page.getByRole("button", { name: /^Approve .* with passkey$/ });
      await approve
        .or(page.getByRole("button", { name: "Create passkey" }))
        .first()
        .waitFor();
      await createPasskeyIfAsked();
      await approve.click();
      await page.getByRole("heading", { level: 1, name: "Approved" }).waitFor();
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
      await page.getByRole("button", { name: "Decline" }).click();
      await page.getByRole("heading", { level: 1, name: "Declined" }).waitFor();
    },
    async close() {
      await save().catch(() => {});
      await context.close();
      await browser.close();
    },
  };
}
