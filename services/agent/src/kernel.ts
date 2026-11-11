import { type Recorder, startRecorder } from "@keelson/evidence/capture";
import Kernel from "@onkernel/sdk";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";

export const VIEWPORT = { width: 1280, height: 800 } as const;

/** A KERNEL browser session the agent drives over CDP. */
export interface Session {
  context: BrowserContext;
  page: Page;
  /** Records the tab's network traffic for the evidence, from before the first navigation. */
  recorder: Recorder;
  /** Kernel's live view of the browser, read-only, for embedding next to the run. */
  liveViewUrl?: string;
  close(): Promise<void>;
}

/**
 * Where to find the browser: a new KERNEL session (`KERNEL_API_KEY`), or one already created
 * and handed over by its CDP URL, which the session's owner deletes. A new session can load a
 * KERNEL profile, such as one the buyer signed in to PayPal with; the run never saves to it.
 */
export type SessionSource =
  | { hosts: readonly string[]; profile?: string; locale?: string }
  | { cdpUrl: string; liveViewUrl?: string };

/**
 * Creates a headful KERNEL browser whose egress is limited to `hosts` (Kernel's network
 * allowlist), connects Playwright over CDP and starts the evidence recorder on a new tab.
 */
export async function openSession(source: SessionSource): Promise<Session> {
  let id: string | undefined;
  let cdpUrl: string;
  let liveViewUrl: string | undefined;
  let kernel: Kernel | undefined;
  if ("hosts" in source) {
    kernel = new Kernel();
    const created = await kernel.browsers.create({
      headless: false,
      timeout_seconds: source.profile ? 900 : 300,
      viewport: { ...VIEWPORT },
      network: { allowed_hosts: [...source.hosts] },
      ...(source.profile ? { profile: { name: source.profile, save_changes: false } } : {}),
      // Pins the browser's language and formatting locale; pages may still render their own.
      ...(source.locale ? { location: { locale: source.locale } } : {}),
    });
    id = created.session_id;
    cdpUrl = created.cdp_ws_url;
    liveViewUrl = created.browser_live_view_url;
  } else {
    cdpUrl = source.cdpUrl;
    liveViewUrl = source.liveViewUrl;
  }
  let browser: Browser | undefined;
  try {
    browser = await chromium.connectOverCDP(cdpUrl);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = await context.newPage();
    await page.setViewportSize({ ...VIEWPORT });
    const recorder = await startRecorder(page);
    const view = liveViewUrl ? new URL(liveViewUrl) : undefined;
    view?.searchParams.set("readOnly", "true");
    return {
      context,
      page,
      recorder,
      ...(view ? { liveViewUrl: view.href } : {}),
      async close() {
        await recorder.stop().catch(() => {});
        await page.close().catch(() => {});
        await browser?.close();
        if (id) await kernel?.browsers.deleteByID(id);
      },
    };
  } catch (err) {
    await browser?.close();
    if (id) await kernel?.browsers.deleteByID(id);
    throw err;
  }
}
