// The buyer's PayPal session for the live flow, in a KERNEL profile. The buyer signs in himself
// in the session's live view; the agent's runs load the profile and never save to it.
//
//   node scripts/paypal-profile.ts open    starts a browser on PayPal's sign-in page and prints its live view
//   node scripts/paypal-profile.ts save ID ends that browser, which saves the signed-in profile
//
//   KERNEL_API_KEY, and PAYPAL_PROFILE (default `keelson-live-paypal`)
import Kernel, { NotFoundError } from "@onkernel/sdk";
import { chromium } from "playwright";

const kernel = new Kernel();
const name = process.env.PAYPAL_PROFILE ?? "keelson-live-paypal";
const [command, id] = process.argv.slice(2);

if (command === "open") {
  await kernel.profiles.retrieve(name).catch(async (err: unknown) => {
    if (!(err instanceof NotFoundError)) throw err;
    await kernel.profiles.create({ name });
  });
  const created = await kernel.browsers.create({
    headless: false,
    timeout_seconds: 1800,
    viewport: { width: 1280, height: 800 },
    profile: { name, save_changes: true },
  });
  const browser = await chromium.connectOverCDP(created.cdp_ws_url);
  const page = browser.contexts()[0]?.pages()[0] ?? (await browser.contexts()[0]?.newPage());
  await page?.goto("https://www.paypal.com/signin");
  console.log(
    JSON.stringify({ session: created.session_id, liveView: created.browser_live_view_url }),
  );
  process.exit(0);
} else if (command === "save" && id) {
  await kernel.browsers.deleteByID(id);
  const profile = await kernel.profiles.retrieve(name);
  console.log(JSON.stringify({ profile: profile.name, updated: profile.updated_at }));
} else {
  console.error("usage: paypal-profile.ts open | save <session-id>");
  process.exit(2);
}
