import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
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
const ID = "01M777FEC6WWKNJKJRVZ5C3T8B";

const SESSION = () => {
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 86_400_000).toISOString();
  return {
    session: { id: "s", userId: "u", token: "t", expiresAt: later, createdAt: now, updatedAt: now },
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

const confirmation = (over: Record<string, unknown> = {}) => ({
  purchaseId: ID,
  store: "https://www.alfred.com",
  payee: "DZ93UDZC2BKLE",
  total: { currency: "USD", minor: "295" },
  intent: "CAPTURE",
  state: "PENDING",
  expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
  challenge: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  credentialId: "cred",
  spc: {
    payeeName: "www.alfred.com",
    payeeOrigin: "https://www.alfred.com",
    total: { currency: "USD", value: "2.95" },
  },
  ...over,
});

/** A signed-in buyer on the confirmation a push opens, whose API answers come from `answer`. */
async function open(
  kind: Kind,
  answer: (path: string, body: string | null, method: string) => unknown,
) {
  const context = await browser.newContext(VIEWPORTS[kind]);
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
        : url.pathname === "/v1/passkeys"
          ? { passkeys: [{ credentialId: "cred", payment: false }] }
          : answer(url.pathname, req.postData(), req.method());
    if (value === undefined) return route.abort("connectionrefused");
    return route.fulfill({ headers, contentType: "application/json", body: JSON.stringify(value) });
  });
  const page = await context.newPage();
  await page.goto(`${site.base}/amount/?id=${ID}`);
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
}

describe.each<Kind>(["desktop", "mobile"])("confirming an amount (%s)", (kind) => {
  test("shows the store, the order total and one passkey action, and confirms with it", async () => {
    const posted: unknown[] = [];
    const { context, page } = await open(kind, (path, body, method) => {
      if (path !== `/v1/purchases/${ID}/amount-confirmation`) return undefined;
      if (method === "GET") return confirmation();
      posted.push(JSON.parse(body ?? "{}"));
      return confirmation({ state: "CONFIRMED" });
    });
    await expect
      .poll(() => page.getByRole("heading", { name: "Confirm the amount" }).isVisible())
      .toBe(true);
    await expect.poll(() => page.getByText("alfred.com").first().isVisible()).toBe(true);
    await expect.poll(() => page.getByText("DZ93UDZC2BKLE").isVisible()).toBe(true);
    await axe(page);
    await shot(page, kind, "amount-confirm");
    await page.getByRole("button", { name: "Confirm with passkey" }).click();
    await expect
      .poll(() =>
        page.getByRole("heading", { name: "Confirmed. Your agent pays now." }).isVisible(),
      )
      .toBe(true);
    expect(posted).toEqual([
      {
        assertion: expect.objectContaining({
          credentialId: "cred",
          authenticatorData: expect.any(String),
        }),
      },
    ]);
    await context.close();
  });

  test('"Not this amount" declines, and an expired confirmation offers nothing', async () => {
    const posted: unknown[] = [];
    const { context, page } = await open(kind, (path, body, method) => {
      if (path !== `/v1/purchases/${ID}/amount-confirmation`) return undefined;
      if (method === "GET") return confirmation();
      posted.push(JSON.parse(body ?? "{}"));
      return confirmation({ state: "DECLINED" });
    });
    await page.getByRole("button", { name: "Not this amount" }).click();
    await expect
      .poll(() => page.getByRole("heading", { name: "Declined. Nothing is paid." }).isVisible())
      .toBe(true);
    expect(posted).toEqual([{ decline: true }]);
    await context.close();

    const late = await open(kind, (path) =>
      path === `/v1/purchases/${ID}/amount-confirmation`
        ? confirmation({ state: "EXPIRED", expiresAt: new Date(Date.now() - 1000).toISOString() })
        : undefined,
    );
    await expect
      .poll(() => late.page.getByText("Your agent stopped waiting. Nothing was paid.").isVisible())
      .toBe(true);
    expect(await late.page.getByRole("button", { name: "Confirm with passkey" }).count()).toBe(0);
    await late.context.close();
  });
});
