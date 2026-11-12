// The bench account, made once through the product as a user would: in a KERNEL browser's live
// view, a person signs in to the app with sandbox PayPal and saves the sandbox buyer's PayPal on
// the passkeys page. The browser's passkey is Chrome's virtual authenticator, so its key can be
// read back: the script prints it as BENCH_PASSKEY for the benches, which then sign in with it.
//
//   node scripts/bench-account.ts       prints the live view, waits for the saved PayPal, prints
//                                       BENCH_PASSKEY (JSON: credentialId, pkcs8) and ends
//
//   KERNEL_API_KEY; APP_ORIGIN and KEELSON_API_URL (default the deployed app and API)
import Kernel from "@onkernel/sdk";
import { chromium } from "playwright";

const APP = process.env.APP_ORIGIN ?? "https://app.keelson.finance";
const API = process.env.KEELSON_API_URL ?? "https://api.keelson.finance";
const WAIT_MS = 25 * 60_000;

const kernel = new Kernel();
const created = await kernel.browsers.create({
  headless: false,
  timeout_seconds: 1800,
  viewport: { width: 1280, height: 800 },
});
try {
  const browser = await chromium.connectOverCDP(created.cdp_ws_url);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  // Every passkey this tab creates, during onboarding or on the passkeys page, is this one's.
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
  await page.goto(APP);
  console.log(
    JSON.stringify({ session: created.session_id, liveView: created.browser_live_view_url }),
  );
  console.error("Sign in with sandbox PayPal, then save PayPal on the Passkeys page.");

  const saved = async () =>
    page
      .evaluate(
        async (api) => (await fetch(`${api}/v1/paypal/wallet`, { credentials: "include" })).ok,
        API,
      )
      .catch(() => false);
  const until = Date.now() + WAIT_MS;
  while (!(await saved())) {
    if (Date.now() > until) throw new Error("no saved PayPal after 25 minutes");
    await new Promise((r) => setTimeout(r, 5_000));
  }

  let { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  if (credentials.length === 0) {
    await page.goto(`${APP}/passkeys/`);
    await page.getByRole("button", { name: "Add a passkey on this device" }).click();
    for (let i = 0; i < 30 && credentials.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 1_000));
      ({ credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId }));
    }
  }
  const [credential] = credentials;
  if (!credential) throw new Error("the app registered no passkey");
  // The app registered it: the API lists it among the user's passkeys.
  const listed = await page.evaluate(
    async ({ api, id }) => {
      const res = await fetch(`${api}/v1/passkeys`, { credentials: "include" });
      const { passkeys } = (await res.json()) as { passkeys: { credentialId: string }[] };
      return passkeys.some((p) => p.credentialId === id);
    },
    { api: API, id: Buffer.from(credential.credentialId, "base64").toString("base64url") },
  );
  if (!listed) throw new Error("the passkey is not registered with Keelson");
  console.log(
    `BENCH_PASSKEY=${JSON.stringify({
      credentialId: Buffer.from(credential.credentialId, "base64").toString("base64url"),
      pkcs8: credential.privateKey,
    })}`,
  );
} finally {
  await kernel.browsers.deleteByID(created.session_id);
}
