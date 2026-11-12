import { readFile } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { buildSdPayload, parseMandate, renderCard } from "@keelson/mandate";
import { type Browser, chromium, devices, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { serveOut } from "./static";

let browser: Browser;
let site: Awaited<ReturnType<typeof serveOut>>;

beforeAll(async () => {
  site = await serveOut();
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await site?.close();
});

const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 } },
  mobile: devices["Pixel 7"],
} as const;
type Kind = keyof typeof VIEWPORTS;
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

const later = (ms = 86_400_000) => new Date(Date.now() + ms).toISOString();
const SESSION = () => {
  const now = new Date().toISOString();
  return {
    session: {
      id: "s",
      userId: "u",
      token: "t",
      expiresAt: later(),
      createdAt: now,
      updatedAt: now,
    },
    user: {
      id: "u",
      name: "Buyer",
      email: "b@example.test",
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    },
  };
};

const REASON =
  "I am Claude Code, buying the running shoes you asked for in this session. I compare prices at RunFast and check out only what you named.";

const request = (over: Record<string, unknown> = {}) => ({
  code: "BCDF-GHJK",
  kind: "connect",
  state: "PENDING",
  name: "Claude Code",
  reason: REASON,
  agent: {
    agentId: "351",
    operator: "Anthropic Labs",
    bond: { asset: "PYUSD", min: 50_000_000, vault: "eip155:421614:0x0" },
  },
  limits: {
    currency: "USD",
    perPurchaseMinor: "5000",
    totalMinor: "10000",
    askAboveMinor: "2500",
    merchants: [{ id: "mrc_runfast", name: "RunFast" }],
    until: later(2 * 86_400_000),
  },
  parent: null,
  mandateId: null,
  expiresAt: later(14 * 60_000),
  ...over,
});

async function draft() {
  const demo = JSON.parse(
    await readFile(
      new URL("../../../../packages/mandate/test/fixtures/demo-mandate.json", import.meta.url),
      "utf8",
    ),
  );
  const { payloadSd, disclosures } = await buildSdPayload(parseMandate(structuredClone(demo)), () =>
    crypto.getRandomValues(new Uint8Array(16)),
  );
  const card = renderCard(payloadSd, disclosures, {
    merchantSignedCheckout: false,
    zkTlsFields: new Set(),
  });
  return {
    mandateDraft: demo,
    card,
    ambiguous: [],
    check: { status: "skipped", discrepancies: null },
  };
}

/** A signed-in buyer whose API answers come from `answer`; anything else is refused. */
async function signedIn(
  kind: Kind,
  path: string,
  answer: (path: string, body: string | null, method: string) => unknown | Promise<unknown>,
  options: { push?: boolean } = {},
) {
  const context = await browser.newContext(VIEWPORTS[kind]);
  if (options.push) {
    await context.addInitScript(PUSH);
  }
  // A platform authenticator that signs whatever it is asked, as the user's passkey would.
  await context.addInitScript(() => {
    const bytes = (n: number) => new Uint8Array(n).fill(7).buffer;
    Object.defineProperty(navigator.credentials, "get", {
      value: async () => ({
        id: "cred",
        rawId: bytes(4),
        type: "public-key",
        authenticatorAttachment: "platform",
        response: {
          authenticatorData: bytes(37),
          clientDataJSON: new TextEncoder().encode('{"type":"webauthn.get"}').buffer,
          signature: bytes(70),
          userHandle: null,
        },
        getClientExtensionResults: () => ({}),
      }),
    });
  });
  await context.route("https://api.keelson.finance/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const headers = {
      "access-control-allow-origin": site.base,
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "content-type, idempotency-key, keelson-device",
      "access-control-allow-methods": "GET, POST, PUT, DELETE",
    };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const value =
      url.pathname === "/api/auth/get-session"
        ? SESSION()
        : await answer(url.pathname, req.postData(), req.method());
    if (value === undefined) return route.abort("connectionrefused");
    // `{ problem: status, ... }` answers as an RFC 9457 problem.
    const { problem, ...rest } = value as { problem?: number };
    if (problem) {
      return route.fulfill({
        status: problem,
        headers,
        contentType: "application/problem+json",
        body: JSON.stringify(rest),
      });
    }
    return route.fulfill({ headers, contentType: "application/json", body: JSON.stringify(value) });
  });
  const page = await context.newPage();
  await page.goto(`${site.base}${path}`);
  return { context, page };
}

async function axe(page: Page) {
  await page.waitForTimeout(300);
  const { violations } = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(",")}`)).toEqual([]);
}

/** Saves a screenshot at 1440 or 390 wide when `KEELSON_SHOTS` names a directory. */
async function shot(page: Page, kind: Kind, name: string) {
  const dir = process.env.KEELSON_SHOTS;
  if (!dir) return;
  if (kind === "mobile") await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await page.screenshot({
    path: join(dir, `${name}-${kind === "mobile" ? 390 : 1440}.png`),
    fullPage: true,
  });
  if (kind === "mobile") await page.setViewportSize(VIEWPORTS.mobile.viewport);
}

const passkeys = { passkeys: [{ credentialId: "cred", payment: false }] };

const onceRequest = () =>
  request({
    kind: "once",
    reason: "Asks to buy one cart that mandate 01J0 does not allow, and nothing else.",
    limits: {
      currency: "USD",
      perPurchaseMinor: "9400",
      totalMinor: "9400",
      askAboveMinor: null,
      merchants: [{ id: "mrc_runfast", name: "RunFast" }],
      until: later(15 * 60_000),
    },
    parent: {
      mandateId: "01J0000000000000000000000A",
      perPurchaseMinor: "10000",
      totalMinor: "10000",
      remainingMinor: "10000",
      until: later(),
    },
    cart: {
      merchant: { id: "mrc_runfast", name: "RunFast" },
      currency: "USD",
      totalMinor: "9400",
      lines: [
        {
          sku: "RF-PEGASUS-41",
          size: "10",
          color: "Volt",
          category: "gpt:187",
          qty: 1,
          unitMinor: "9400",
        },
      ],
    },
    checks: [
      { field: "total", mandate: "$100.00", cart: "$94.00", pass: true },
      { field: "merchant", mandate: "mrc_runfast", cart: "mrc_runfast", pass: true },
      { field: "variant", mandate: "size 10", cart: "size 10", pass: true },
      { field: "askAbove", mandate: "$25.00", cart: "$94.00", pass: false },
    ],
    match: null,
    expiresAt: later(14 * 60_000 + 30_000),
  });

/** A browser that grants notifications and whose push service subscribes, as Chrome's would. */
const PUSH = () => {
  const sub = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc",
    expirationTime: null,
    keys: { p256dh: `B${"A".repeat(86)}`, auth: "AAAAAAAAAAAAAAAAAAAAAA" },
  };
  let subscribed: unknown = null;
  // Headless Chromium answers every notification permission with "denied".
  let permission: NotificationPermission = "default";
  Object.defineProperty(Notification, "permission", { get: () => permission });
  Notification.requestPermission = async () => {
    permission = "granted";
    return permission;
  };
  PushManager.prototype.getSubscription = async () => subscribed as PushSubscription | null;
  PushManager.prototype.subscribe = async (options) => {
    (window as unknown as { pushKey: unknown }).pushKey = options?.applicationServerKey;
    subscribed = {
      ...sub,
      toJSON: () => sub,
      unsubscribe: async () => {
        subscribed = null;
        return true;
      },
    };
    return subscribed as PushSubscription;
  };
};

describe.each(Object.keys(VIEWPORTS) as Kind[])("alerts and approvals on %s", (kind) => {
  test("a paused cart shows what the agent saw against the mandate, with a live countdown", async () => {
    const { context, page } = await signedIn(
      kind,
      "/connect/?c=BCDF-GHJK",
      (path) => {
        if (path === "/v1/connections/BCDF-GHJK") return onceRequest();
        if (path === "/v1/connections/BCDF-GHJK/draft") return draft();
        if (path === "/v1/passkeys") return passkeys;
        return undefined;
      },
      { push: true },
    );
    await page.getByRole("heading", { level: 1, name: "Claude Code wants $94.00" }).waitFor();
    await page.getByText("Approve soon — the price may change.", { exact: false }).waitFor();
    const timer = page.getByRole("timer");
    const first = await timer.textContent();
    expect(first).toMatch(/^Expires in 1[34]:\d\d$/);
    await expect.poll(() => timer.textContent(), { timeout: 5_000 }).not.toBe(first);
    const table = page.getByRole("table", { name: "Each field of your mandate against the cart" });
    const failing = table.getByRole("row", { name: /Ask me above.*outside the mandate/ });
    expect(await failing.getAttribute("class")).toContain("bg-warn/10");
    expect(await table.getByRole("row", { name: /within/ }).count()).toBe(3);
    expect(await page.getByText("RF-PEGASUS-41").count()).toBe(1);
    expect(await page.getByText("Run by Anthropic Labs, registered agent #351").count()).toBe(1);
    await page.getByRole("complementary", { name: "Phone approvals" }).waitFor();
    await page
      .getByRole("button", { name: "Approve once · $94.00" })
      .and(page.locator(":enabled"))
      .waitFor();
    expect(await page.getByText("Error", { exact: true }).count()).toBe(0);
    await axe(page);
    await shot(page, kind, "approval-once-diff");
    await context.close();
  });

  test("phone approvals turn on, test and turn off; email is confirmed before mail", async () => {
    const posted: { path: string; body: string | null }[] = [];
    let email = { address: null as string | null, confirmed: false };
    const { context, page } = await signedIn(
      kind,
      "/alerts/",
      async (path, body, method) => {
        if (method !== "GET") posted.push({ path: `${method} ${path}`, body });
        if (path === "/v1/push/key")
          return {
            publicKey:
              "BIgttCNLXCTetxKzJEOOm6rJJbiwwq5XUgWNC14Q1XDLvFkaycjWn8zaTjySVi7eoFU3_CE9Yr8vCVc8y8mtOqg",
          };
        if (path === "/v1/push/subscriptions") return method === "DELETE" ? {} : { id: "01J" };
        if (path === "/v1/push/test") return { sent: 1 };
        if (path === "/v1/alerts/email") {
          if (method === "PUT")
            email = { address: JSON.parse(body ?? "{}").address, confirmed: false };
          return email;
        }
        if (path === "/v1/alerts/emails") {
          return {
            emails: [
              {
                id: "01JE",
                address: "me@example.com",
                event: "purchase.blocked",
                subject: "Keelson blocked a $140.00 cart at RunFast",
                subjectId: "01JP",
                logIndex: "783",
                alibiUrl: "https://verify.keelson.finance/a/01JP",
                sentAt: new Date().toISOString(),
                error: null,
                createdAt: new Date().toISOString(),
              },
            ],
          };
        }
        return undefined;
      },
      { push: true },
    );
    await page.getByRole("heading", { level: 1, name: "Alerts" }).waitFor();
    await page.getByRole("button", { name: "Turn on phone approvals" }).click();
    await page.getByText("On for this device").waitFor();
    const sub = posted.find((p) => p.path === "POST /v1/push/subscriptions");
    expect(JSON.parse(sub?.body ?? "{}")).toMatchObject({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: { auth: "AAAAAAAAAAAAAAAAAAAAAA" },
    });
    await page.getByRole("button", { name: "Send a test notification" }).click();
    await page.getByText("Sent. It should arrive within a few seconds.").waitFor();

    await page.getByLabel("Email address for alerts").fill("me@example.com");
    await page.getByRole("button", { name: "Send confirmation link" }).click();
    await page.getByText("Waiting for you to open the link we sent.", { exact: false }).waitFor();
    expect(await page.getByRole("link", { name: "Alibi" }).getAttribute("href")).toBe(
      "https://verify.keelson.finance/a/01JP",
    );
    await page.getByText("Log entry #783").waitFor();
    await axe(page);
    await shot(page, kind, "alerts");
    await page.getByRole("button", { name: "Turn off on this device" }).click();
    await page.getByRole("button", { name: "Turn on phone approvals" }).waitFor();
    expect(posted.some((p) => p.path === "DELETE /v1/push/subscriptions")).toBe(true);
    await context.close();
  });

  test("the confirmation link confirms on a click, never on load", async () => {
    const posts: string[] = [];
    const { context, page } = await signedIn(
      kind,
      "/alerts/confirm/?token=abc.def",
      (path, body) => {
        if (path === "/v1/alerts/email/confirm") {
          posts.push(body ?? "");
          return { address: "me@example.com" };
        }
        return undefined;
      },
    );
    await page.getByRole("heading", { level: 1, name: "Confirm your email for alerts" }).waitFor();
    expect(posts).toEqual([]);
    await axe(page);
    await page.getByRole("button", { name: "Confirm this address" }).click();
    await page.getByText("me@example.com is confirmed.", { exact: false }).waitFor();
    expect(JSON.parse(posts[0] ?? "{}")).toEqual({ token: "abc.def" });
    await context.close();
  });

  test("activity reads in plain lines with the Alibi and log entry, by agent", async () => {
    const asked: string[] = [];
    const now = Date.now();
    const rows = [
      {
        id: "3",
        at: new Date(now - 60_000).toISOString(),
        tone: "good",
        line: "Claude Code bought $94.00 at RunFast.",
        agentId: "351",
        purchaseId: "01JP0000000000000000000001",
        mandateId: "01JM",
        href: "/purchase/?mandate=01JM&id=01JP0000000000000000000001",
        alibiUrl: "https://verify.keelson.finance/a/01JP0000000000000000000001",
        logIndex: "784",
      },
      {
        id: "2",
        at: new Date(now - 120_000).toISOString(),
        tone: "bad",
        line: "Keelson blocked Claude Code's $140.00 cart at RunFast. Nothing was paid.",
        agentId: "351",
        purchaseId: "01JP0000000000000000000002",
        mandateId: "01JM",
        href: "/purchase/?mandate=01JM&id=01JP0000000000000000000002",
        alibiUrl: "https://verify.keelson.finance/a/01JP0000000000000000000002",
        logIndex: "783",
      },
      {
        id: "1",
        at: new Date(now - 180_000).toISOString(),
        tone: "warn",
        line: "Claude Code asked you to approve $94.00 at RunFast.",
        agentId: "351",
        purchaseId: null,
        mandateId: "01JM",
        href: "/connect/?c=BCDF-GHJK",
        alibiUrl: null,
        logIndex: null,
      },
    ];
    const agent = (agentId: string, name: string) => ({
      agentId,
      name,
      operator: "Anthropic Labs",
      connected: true,
      mandate: null,
      lastActivityAt: new Date().toISOString(),
    });
    const { context, page } = await signedIn(kind, "/activity/", (path) => {
      if (path === "/v1/activity") {
        return { rows };
      }
      if (path === "/v1/agents")
        return { agents: [agent("351", "Claude Code"), agent("352", "Codex")] };
      return undefined;
    });
    page.on("request", (r) => {
      if (r.url().includes("/v1/activity")) asked.push(new URL(r.url()).search);
    });
    await page.getByRole("heading", { level: 1, name: "Activity" }).waitFor();
    await page.getByRole("link", { name: "Claude Code bought $94.00 at RunFast." }).waitFor();
    expect(await page.getByRole("link", { name: /^Alibi/ }).count()).toBe(2);
    await page.getByText("Log #783").waitFor();
    await page.getByText("Needs you:", { exact: false }).first().waitFor({ state: "attached" });
    await axe(page);
    await shot(page, kind, "activity");
    await page.getByLabel("Agent").selectOption("352");
    await expect.poll(() => asked).toContain("?agent=352");
    await context.close();
  });

  test("a purchase lost at capture says the outcome is unknown, and checks again", async () => {
    let reads = 0;
    const mandateId = "01JM0000000000000000000000";
    const purchaseId = "01JP0000000000000000000003";
    const { context, page } = await signedIn(
      kind,
      `/purchase/?mandate=${mandateId}&id=${purchaseId}`,
      (path) => {
        if (path === `/v1/mandates/${mandateId}`) {
          reads++;
          return {
            id: mandateId,
            state: "ACTIVE",
            mandateHash: null,
            budget: { currency: "USD", maxMinor: "10000", remainingMinor: "600" },
            expiresAt: later(),
            hold: null,
            card: { rows: [], warnings: [] },
            purchases: [
              {
                id: purchaseId,
                merchantId: "mrc_runfast",
                amount: { currency: "USD", minor: "9400" },
                createdAt: new Date().toISOString(),
                state: "FAILED",
                mode: "2of2",
                logIndex: "785",
                failure: { step: "capture", reason: "window-closed" },
                disputes: [],
              },
            ],
            pendingHolds: [],
          };
        }
        return undefined;
      },
    );
    await page
      .getByRole("heading", {
        name: "We don't know the outcome yet — PayPal may already have charged you.",
      })
      .waitFor();
    await page.getByText("Don't start this purchase again.").waitFor();
    expect(await page.getByText("Not paid").count()).toBe(0);
    const before = reads;
    await page.getByRole("button", { name: "Check again" }).click();
    await page.getByText("Still unknown at", { exact: false }).waitFor();
    expect(reads).toBe(before + 1);
    await axe(page);
    await shot(page, kind, "purchase-unknown-outcome");
    await context.close();
  });
});
