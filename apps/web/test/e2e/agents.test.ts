import { readFile } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { buildSdPayload, parseMandate, renderCard } from "@keelson/mandate";
import { type Browser, type BrowserContextOptions, chromium, devices, type Page } from "playwright";
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
  kind: Kind | BrowserContextOptions,
  path: string,
  answer: (path: string, body: string | null, method: string) => unknown | Promise<unknown>,
) {
  const context = await browser.newContext(typeof kind === "string" ? VIEWPORTS[kind] : kind);
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

describe.each(Object.keys(VIEWPORTS) as Kind[])("connecting an agent on %s", (kind) => {
  test("first run: the prompt to paste and the code the agent shows", async () => {
    const { context, page } = await signedIn(kind, "/connect/", () => undefined);
    await page.getByRole("heading", { level: 1, name: "Connect your agent" }).waitFor();
    expect(await page.getByText("keelson.request_mandate", { exact: false }).count()).toBe(1);
    expect(await page.getByText("keelson.get_request", { exact: false }).count()).toBe(1);
    const code = page.getByLabel("The code your agent shows");
    await code.fill("bcdf ghjk");
    expect(await page.getByRole("button", { name: "Open" }).isDisabled()).toBe(true);
    await code.fill("bcdfghjk");
    await axe(page);
    await shot(page, kind, "connect-first-run");
    await page.getByRole("button", { name: "Open" }).click();
    await page.waitForURL(/\/connect\/\?c=BCDF-GHJK$/);
    await context.close();
  });

  test("a relayed link opens only once the user picks the number their agent shows", async () => {
    const matched: number[] = [];
    const { context, page } = await signedIn(kind, "/connect/?c=BCDF-GHJK", (path, body) => {
      if (path === "/v1/connections/BCDF-GHJK") {
        return request({ match: { options: [17, 42, 88], matched: false } });
      }
      if (path === "/v1/connections/BCDF-GHJK/match") {
        matched.push(JSON.parse(body ?? "{}").number);
        return { matched: true };
      }
      if (path === "/v1/connections/BCDF-GHJK/draft") return draft();
      if (path === "/v1/passkeys") return passkeys;
      return undefined;
    });
    await page
      .getByRole("heading", { level: 1, name: "Which number does Claude Code show?" })
      .waitFor();
    await axe(page);
    await shot(page, kind, "connect-number-match");
    await page.getByRole("button", { name: "42" }).click();
    await page.getByRole("heading", { level: 1, name: /Claude Code wants to spend/ }).waitFor();
    expect(matched).toEqual([42]);
    await context.close();
  });

  test("a wrong number cancels the request and says why", async () => {
    const { context, page } = await signedIn(kind, "/connect/?c=BCDF-GHJK", (path) => {
      if (path === "/v1/connections/BCDF-GHJK") {
        return request({ match: { options: [17, 42, 88], matched: false } });
      }
      if (path === "/v1/connections/BCDF-GHJK/match") {
        return {
          problem: 409,
          type: "https://api.keelson.finance/problems/number-mismatch",
          title: "Not your agent's number",
          detail:
            "The number does not match the one Claude Code shows, so this request was denied.",
        };
      }
      return undefined;
    });
    await page.getByRole("button", { name: "17" }).click();
    await page.getByRole("heading", { level: 1, name: "That's not your agent's number" }).waitFor();
    await context.close();
  });

  test("the request is lowered, approved with a passkey that names the amount, and restated", async () => {
    const compiled = await draft();
    let drafted: { limits: Record<string, unknown> } | undefined;
    let stored: Record<string, unknown> | undefined;
    const { context, page } = await signedIn(kind, "/connect/?c=BCDF-GHJK", (path, body) => {
      if (path === "/v1/connections/BCDF-GHJK") return request();
      if (path === "/v1/connections/BCDF-GHJK/draft") {
        drafted = JSON.parse(body ?? "{}");
        return compiled;
      }
      if (path === "/v1/passkeys") return passkeys;
      if (path === "/v1/mandates") {
        stored = JSON.parse(body ?? "{}");
        return { id: "01M7MANDATE000000000000000", state: "SIGNED" };
      }
      return undefined;
    });
    await page
      .getByRole("heading", { level: 1, name: "Claude Code wants to spend up to $100.00" })
      .waitFor();
    expect(await page.getByText("Expires in 14 min").count()).toBe(1);
    expect(await page.getByText(REASON).count()).toBe(1);
    expect(await page.getByText("Bond-backed", { exact: false }).count()).toBe(1);
    expect(
      await page
        .getByText("Changing limits never affects purchases already in flight", { exact: false })
        .count(),
    ).toBe(1);
    const total = page.getByRole("slider", { name: "Most in total" });
    expect(await total.getAttribute("max")).toBe("10000");
    await total.fill("8000");
    await page.getByRole("button", { name: "Approve $80.00 with passkey" }).waitFor();
    await page.waitForFunction(() => {
      const b = [...document.querySelectorAll("button")].find((x) =>
        x.textContent?.includes("Approve $80.00"),
      );
      return b !== undefined && !b.hasAttribute("disabled");
    });
    expect(drafted?.limits).toMatchObject({
      totalMinor: 8000,
      perPurchaseMinor: 5000,
      askAboveMinor: 2500,
    });
    await axe(page);
    await shot(page, kind, "approval");

    await page.getByRole("button", { name: "Approve $80.00 with passkey" }).click();
    await page.getByRole("heading", { level: 1, name: "Approved" }).waitFor();
    expect(stored?.connection).toEqual({ code: "BCDF-GHJK", askAboveMinor: 2500 });
    expect(
      await page
        .getByText("Claude Code can spend up to $80.00 at RunFast until", { exact: false })
        .count(),
    ).toBe(1);
    expect(await page.getByText("Revoke it any time.").count()).toBe(1);
    expect(
      await page.getByRole("link", { name: "Hold $80.00 on PayPal" }).getAttribute("href"),
    ).toBe("/new/?hold=01M7MANDATE000000000000000");
    await axe(page);
    await shot(page, kind, "approved");
    await context.close();
  });

  test("an expired code says so, and a cart over the mandate is approved once or declined", async () => {
    const compiled = await draft();
    const once = request({
      code: "BCDF-GHJM",
      kind: "once",
      reason: "Asks to buy one cart that mandate 01M7 does not allow, and nothing else.",
      limits: {
        currency: "USD",
        perPurchaseMinor: "6200",
        totalMinor: "6200",
        askAboveMinor: null,
        merchants: [{ id: "mrc_runfast", name: "RunFast" }],
        until: later(15 * 60_000),
      },
      parent: {
        mandateId: "01M7MANDATE000000000000000",
        perPurchaseMinor: "5000",
        remainingMinor: "5000",
      },
    });
    const { context, page } = await signedIn(kind, "/connect/?c=BCDF-GHJM", (path) => {
      if (path === "/v1/connections/BCDF-GHJM") return once;
      if (path === "/v1/connections/BCDF-GHJM/draft") return compiled;
      if (path === "/v1/connections/BCDF-GHJM/deny") return { state: "DENIED" };
      if (path === "/v1/passkeys") return passkeys;
      return undefined;
    });
    await page.getByRole("heading", { level: 1, name: "Claude Code wants $62.00" }).waitFor();
    expect(
      await page.getByText("$12.00 above this mandate. Paused until you answer.").count(),
    ).toBe(1);
    await page.getByRole("button", { name: "Approve once · $62.00" }).waitFor();
    await axe(page);
    await shot(page, kind, "reapproval");
    await page.getByRole("button", { name: "Decline" }).click();
    await page.getByRole("heading", { level: 1, name: "Declined" }).waitFor();
    await context.close();

    const expired = await signedIn(kind, "/connect/?c=BCDF-GHJK", (path) =>
      path === "/v1/connections/BCDF-GHJK" ? request({ state: "EXPIRED" }) : undefined,
    );
    await expired.page.getByRole("heading", { level: 1, name: "This request expired" }).waitFor();
    await expired.context.close();
  });
});

describe.each(Object.keys(VIEWPORTS) as Kind[])("an app's consent on %s", (kind) => {
  test("an unverified client: what it may read, that it cannot pay, and Allow and Deny side by side", async () => {
    const { context, page } = await signedIn(
      kind,
      "/consent/?client_id=c1&scope=alibis%3Aread&sig=x",
      (path) =>
        path === "/v1/oauth/consent"
          ? {
              client: {
                id: "c1",
                name: "Inspector",
                uri: "https://inspector.example",
                verified: false,
                identity: { kind: "unverified" },
              },
              agent: null,
              scopes: ["alibis:read"],
              spending: {
                name: "Inspector",
                reason: REASON,
                limits: {
                  currency: "USD",
                  perPurchaseMinor: 5000,
                  totalMinor: 5000,
                  merchants: ["mrc_runfast"],
                  until: later(),
                },
              },
              spendingError: null,
            }
          : undefined,
    );
    await page.getByRole("heading", { level: 1, name: "Inspector wants to connect" }).waitFor();
    expect(await page.getByText("Unverified app").count()).toBe(1);
    expect(await page.getByTestId("identity-lock").count()).toBe(0);
    expect(await page.getByRole("checkbox", { name: /receipt/ }).isChecked()).toBe(true);
    expect(
      await page.getByText("It cannot pay outside these rules", { exact: false }).count(),
    ).toBe(1);
    const deny = await page.getByRole("button", { name: "Deny" }).boundingBox();
    const allow = await page.getByRole("button", { name: "Allow, then approve" }).boundingBox();
    expect(Math.round(deny?.width ?? 0)).toBe(Math.round(allow?.width ?? 1));
    await axe(page);
    await shot(page, kind, "consent");
    await page.getByRole("checkbox", { name: /receipt/ }).uncheck();
    expect(await page.getByRole("button", { name: "Allow, then approve" }).isDisabled()).toBe(true);
    await context.close();
  });

  test("a host with no operator of its own: what it can do, what it never can, and who answers", async () => {
    const scopes = [
      "alibis:read",
      "mandates:request",
      "evidence:write",
      "purchases:write",
      "offline_access",
    ];
    let sent: unknown;
    const { context, page } = await signedIn(
      kind,
      `/consent/?client_id=c2&scope=${encodeURIComponent(scopes.join(" "))}&sig=x`,
      (path, body) => {
        if (path === "/api/auth/oauth2/consent") {
          sent = JSON.parse(body ?? "{}");
          return { url: `${site.base}/` };
        }
        return path === "/v1/oauth/consent"
          ? {
              client: {
                id: "https://claude.ai/oauth/mcp-oauth-client-metadata",
                name: "Claude",
                uri: "https://claude.ai",
                verified: true,
                identity: { kind: "cimd", host: "claude.ai", clientUri: "https://claude.ai" },
              },
              agent: { agentId: "351", operator: "Keelson", hosted: true },
              scopes,
              spending: null,
              spendingError: null,
            }
          : undefined;
      },
    );
    await page.getByRole("heading", { level: 1, name: "Claude wants to connect" }).waitFor();
    // The host the server fetched Claude's metadata document from, next to a lock.
    await page.getByTestId("identity-lock").waitFor();
    expect(await page.getByText("Verified claude.ai").count()).toBe(1);
    expect(await page.getByText("Unverified app").count()).toBe(0);
    const can = page.getByRole("region", { name: "It can" });
    for (const name of [
      /Ask you for a spending mandate/,
      /Buy within a mandate you signed/,
      /Keep what it read at the store/,
      /receipt of each purchase/,
      /Stay connected/,
    ]) {
      expect(await can.getByRole("checkbox", { name }).isChecked()).toBe(true);
    }
    const never = page.getByRole("region", { name: "It can never" });
    expect(await never.getByRole("checkbox").count()).toBe(0);
    expect(await never.getByText(/PayPal login/).count()).toBe(1);
    expect(await never.getByText(/Spend above what you sign/).count()).toBe(1);
    expect(
      await page.getByRole("region", { name: "Who answers for its purchases" }).textContent(),
    ).toContain("Keelson's own agent, #351");
    await axe(page);
    await shot(page, kind, "consent-hosted");
    await can.getByRole("checkbox", { name: /Stay connected/ }).uncheck();
    await page.getByRole("button", { name: "Allow", exact: true }).click();
    await expect
      .poll(() => sent)
      .toMatchObject({
        accept: true,
        scope: "alibis:read mandates:request evidence:write purchases:write",
      });
    await context.close();
  });
});

describe.each(Object.keys(VIEWPORTS) as Kind[])("a lookalike app name on %s", (kind) => {
  test("a name that mixes alphabets is flagged with what it looks like", async () => {
    const { context, page } = await signedIn(
      kind,
      "/consent/?client_id=c3&scope=alibis%3Aread&sig=x",
      (path) =>
        path === "/v1/oauth/consent"
          ? {
              client: {
                id: "c3",
                // A Cyrillic "а" in place of the Latin "a".
                name: "P\u0430yPal Store",
                uri: null,
                verified: false,
                identity: { kind: "unverified" },
              },
              agent: null,
              scopes: ["alibis:read"],
              spending: null,
              spendingError: null,
            }
          : undefined,
    );
    await page
      .getByText("Looks like “PayPal Store”. This name mixes alphabets.", { exact: false })
      .waitFor();
    expect(await page.getByText("Unverified app").count()).toBe(1);
    await axe(page);
    await shot(page, kind, "consent-lookalike");
    await context.close();
  });
});

describe.each(Object.keys(VIEWPORTS) as Kind[])("agents on %s", (kind) => {
  test("each agent with what is left, and a stop whose reach is said", async () => {
    const agents = [
      {
        agentId: "351",
        name: "Claude Code",
        operator: "Anthropic Labs",
        connected: true,
        mandate: {
          id: "01M7MANDATE000000000000000",
          state: "ACTIVE",
          currency: "USD",
          maxMinor: "5000",
          remainingMinor: "1194",
          expiresAt: later(),
          merchants: ["RunFast"],
        },
        lastActivityAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      },
    ];
    const { context, page } = await signedIn(kind, "/agents/", (path) =>
      path === "/v1/agents" ? { agents } : undefined,
    );
    await page.getByRole("heading", { level: 1, name: "Agents" }).waitFor();
    await page.getByText("$11.94").waitFor();
    expect(await page.getByText("left of $50.00").count()).toBe(1);
    expect(
      await page
        .getByRole("meter", { name: "Claude Code has spent" })
        .getAttribute("aria-valuenow"),
    ).toBe("3806");
    await axe(page);
    await shot(page, kind, "agents");
    await page.getByRole("button", { name: "Revoke options for Claude Code" }).click();
    const dialog = page.getByRole("dialog", { name: "Stop Claude Code" });
    await dialog.waitFor();
    expect(
      await dialog
        .getByText(
          "Takes effect immediately. Keelson will refuse every payment from this agent from now on.",
          { exact: false },
        )
        .count(),
    ).toBe(1);
    expect(await dialog.getByRole("button", { name: /Revoke this mandate/ }).count()).toBe(1);
    expect(await dialog.getByRole("button", { name: /Disconnect this agent/ }).count()).toBe(1);
    await axe(page);
    await shot(page, kind, "agents-revoke");
    await context.close();
  });

  test("held to confirm, the stop says what PayPal releases and where it is logged", async () => {
    const agents = [
      {
        agentId: "351",
        name: "Claude Code",
        operator: "Anthropic Labs",
        connected: true,
        mandate: {
          id: "01M7MANDATE000000000000000",
          state: "ACTIVE",
          currency: "USD",
          maxMinor: "50000",
          remainingMinor: "41200",
          expiresAt: later(),
          merchants: ["RunFast"],
        },
        lastActivityAt: new Date().toISOString(),
      },
    ];
    let stopped = 0;
    const { context, page } = await signedIn(kind, "/agents/", (path, _body, method) => {
      if (path === "/v1/agents") return { agents };
      if (path === "/v1/agents/stop" && method === "POST") {
        stopped++;
        return {
          id: "01M7STOP000000000000000000",
          revoked: 1,
          cardsClosed: 2,
          released: [{ currency: "USD", minor: "41200" }],
          releasing: [],
          mandateHashes: ["ab".repeat(32)],
          logIndexes: { "log.keelson.finance/alibi/2026-1": "1207" },
          logged: true,
          createdAt: new Date().toISOString(),
          statusListed: 1,
        };
      }
      return undefined;
    });
    const stop = page.getByRole("button", { name: "Hold to stop all agents" });
    await stop.waitFor();
    // A tap is not enough.
    await stop.click();
    await page.waitForTimeout(300);
    expect(stopped).toBe(0);
    const box = await stop.boundingBox();
    if (!box) throw new Error("no stop button");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(1800);
    await page.mouse.up();
    await page
      .getByText("All agents stopped. $412.00 of holds released. 2 single-use cards closed.")
      .waitFor();
    expect(await page.getByText("entry #1207", { exact: false }).count()).toBe(1);
    const listed = page.getByRole("link", { name: "1 approval revoked in the public status list" });
    expect(await listed.getAttribute("href")).toBe(
      "https://api.keelson.finance/status/v1/mandates/2026-1",
    );
    expect(stopped).toBe(1);
    await axe(page);
    await shot(page, kind, "agents-stopped");
    await context.close();
  });

  test("no agents yet: the prompt to paste, never a grid of zeros", async () => {
    const { context, page } = await signedIn(kind, "/agents/", (path) =>
      path === "/v1/agents" ? { agents: [] } : undefined,
    );
    await page.getByRole("heading", { level: 2, name: "No agents yet" }).waitFor();
    expect(await page.getByText("Hold to stop all agents").count()).toBe(0);
    await axe(page);
    await context.close();
  });
});

const MCP_URL = "https://api.keelson.finance/mcp";

describe.each([
  [1440, { viewport: { width: 1440, height: 900 } }],
  [390, { ...devices["iPhone 15"], viewport: { width: 390, height: 844 } }],
] as const)("connect steps for each host at %i wide", (width, options) => {
  test("a keyboard tablist: Claude, ChatGPT, Cursor and Claude Code, each with exact steps", async () => {
    const { context, page } = await signedIn(
      { ...options, permissions: ["clipboard-read", "clipboard-write"] },
      "/connect/",
      () => undefined,
    );
    const hosts = page.getByRole("tablist", { name: "Your agent's app" });
    await hosts.waitFor();
    expect(await hosts.getByRole("tab").allInnerTexts()).toEqual([
      "Claude",
      "ChatGPT",
      "Cursor",
      "Claude Code",
    ]);
    const panel = page.getByRole("tabpanel");
    const claude = page.getByRole("tab", { name: "Claude", exact: true });
    expect(await claude.getAttribute("aria-selected")).toBe("true");
    expect(await panel.getByText("Add custom connector").count()).toBe(1);
    expect(await panel.getByText(MCP_URL, { exact: true }).count()).toBe(1);
    expect(await panel.getByText(/turn Keelson on in each chat/).count()).toBe(1);
    await axe(page);

    await claude.focus();
    await page.keyboard.press("ArrowRight");
    const chatgpt = page.getByRole("tab", { name: "ChatGPT" });
    await expect.poll(() => chatgpt.getAttribute("aria-selected")).toBe("true");
    expect(await chatgpt.evaluate((el) => el === document.activeElement)).toBe(true);
    expect(await panel.getByText("Add custom MCP server").count()).toBe(1);
    expect(await panel.getByText(/not .No authentication./).count()).toBe(1);

    await page.keyboard.press("ArrowRight");
    await expect.poll(() => panel.getByText('"mcpServers"', { exact: false }).count()).toBe(1);
    expect(await panel.getByText('"mcpServers"', { exact: false }).count()).toBe(1);
    expect(await panel.getByText("~/.cursor/mcp.json").count()).toBeGreaterThan(0);
    await axe(page);

    await page.keyboard.press("End");
    const command = `claude mcp add --transport http keelson ${MCP_URL}`;
    await expect.poll(() => panel.getByText(command, { exact: true }).count()).toBe(1);
    expect(await panel.getByText(command, { exact: true }).count()).toBe(1);
    await panel.getByRole("button", { name: "Copy the command" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(command);
    await axe(page);

    await page.getByRole("tab", { name: "Claude Code" }).focus();
    await page.keyboard.press("Home");
    await expect.poll(() => claude.getAttribute("aria-selected")).toBe("true");
    const [scroll, inner] = await page.evaluate(() => [
      document.documentElement.scrollWidth,
      innerWidth,
    ]);
    expect(scroll).toBeLessThanOrEqual(inner);
    expect(inner).toBe(width);
    await shot(page, width === 390 ? "mobile" : "desktop", "connect-hosts");
    await context.close();
  });
});

describe.each(Object.keys(VIEWPORTS) as Kind[])("home on %s", (kind) => {
  test("a paused cart asks to approve once or decline, beside the get-started checklist", async () => {
    const { card } = await draft();
    const id = "01M7MANDATE000000000000000";
    const { context, page } = await signedIn(kind, "/", (path) => {
      if (path === "/v1/mandates") {
        return {
          mandates: [
            {
              id,
              state: "ACTIVE",
              budget: { currency: "USD", maxMinor: "5000", remainingMinor: "5000" },
              merchantIds: ["mrc_runfast"],
              holdMode: "mandate",
              expiresAt: later(),
              createdAt: new Date().toISOString(),
            },
          ],
        };
      }
      if (path === `/v1/mandates/${id}`) {
        return {
          id,
          state: "ACTIVE",
          mandateHash: null,
          budget: { currency: "USD", maxMinor: "5000", remainingMinor: "5000" },
          expiresAt: later(),
          hold: null,
          card,
          purchases: [],
          pendingHolds: [],
        };
      }
      if (path === "/v1/agents") return { agents: [] };
      if (path === "/v1/approvals") {
        return {
          approvals: [
            {
              code: "BCDF-GHJM",
              name: "Claude Code",
              currency: "USD",
              amountMinor: "6200",
              overMinor: "1200",
              merchant: "RunFast",
              mandateId: id,
              expiresAt: later(15 * 60_000),
            },
          ],
        };
      }
      return undefined;
    });
    await page.getByText("Claude Code wants $62.00, $12.00 above this mandate").waitFor();
    expect(await page.getByRole("link", { name: "Approve once" }).getAttribute("href")).toBe(
      "/connect/?c=BCDF-GHJM",
    );
    const started = page.getByRole("region", { name: "Get started" });
    await started.waitFor();
    expect(await started.getByText("1/3").count()).toBe(1);
    await axe(page);
    await shot(page, kind, "home-paused");
    await context.close();
  });
});
