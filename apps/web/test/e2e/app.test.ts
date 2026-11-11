import { readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import AxeBuilder from "@axe-core/playwright";
import { buildSdPayload, parseMandate, renderCard } from "@keelson/mandate";
import { type Browser, type BrowserContext, chromium, devices, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { parse } from "yaml";
import { statementOf } from "../../../../packages/alibi/src/codec.ts";
import { v2Bundle } from "../../../../packages/alibi/test/v2.ts";
import { CSP } from "../../csp";

// Serves the static export, which turbo builds before the tests, as the static site does.
const out = fileURLToPath(new URL("../../out", import.meta.url));
const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".riv": "application/octet-stream",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

async function file(path: string): Promise<string | undefined> {
  for (const candidate of [path, join(path, "index.html")]) {
    if ((await stat(candidate).catch(() => undefined))?.isFile()) return candidate;
  }
  return undefined;
}

let server: Server;
let base: string;
let browser: Browser;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const path = await file(
      join(out, decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)),
    );
    if (!path) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[extname(path)] ?? "application/octet-stream",
      "content-security-policy": CSP,
    });
    res.end(await readFile(path));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 860 } },
  mobile: devices["Pixel 7"],
} as const;

/**
 * A signed-out visitor: the API is unreachable from this origin, so the session read fails and
 * the app shows what a visitor without a session sees.
 */
async function visit(kind: keyof typeof VIEWPORTS, path = "/", reducedMotion = false) {
  const context: BrowserContext = await browser.newContext({
    ...VIEWPORTS[kind],
    reducedMotion: reducedMotion ? "reduce" : "no-preference",
  });
  await context.route("https://api.keelson.finance/**", (route) =>
    route.abort("connectionrefused"),
  );
  const page: Page = await context.newPage();
  await page.goto(`${base}${path}`);
  await page.getByRole("heading", { level: 1 }).waitFor();
  return { context, page };
}

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

/** Waits until the example cart of the welcome scene has been bought (GSAP has run). */
const verdictShown = (page: Page) =>
  page.waitForFunction(
    () => {
      const v = document.querySelector<HTMLElement>('[data-verdict="a"]');
      return v !== null && Number(getComputedStyle(v).opacity) > 0.9;
    },
    undefined,
    { timeout: 15_000 },
  );

describe.each(Object.keys(VIEWPORTS) as (keyof typeof VIEWPORTS)[])("welcome on %s", (kind) => {
  test("asks for one decision: connect PayPal, or sign in with a passkey", async () => {
    const { context, page } = await visit(kind);
    await expect(page.getByRole("heading", { level: 1 }).textContent()).resolves.toBe(
      "Connect your PayPal",
    );
    expect(await page.getByRole("button", { name: "Continue with PayPal" }).isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "I have a passkey" }).isVisible()).toBe(true);
    expect(await page.getByRole("list", { name: "Step 1 of 4" }).count()).toBe(1);
    await context.close();
  });

  test("has no WCAG 2.2 A or AA violations, while the scene plays", async () => {
    const { context, page } = await visit(kind);
    await verdictShown(page);
    const { violations } = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    await context.close();
  });

  test("plays the example: a cart inside the mandate is bought, one outside is blocked", async () => {
    const { context, page } = await visit(kind);
    await verdictShown(page);
    await page.waitForFunction(
      () => {
        const v = document.querySelector<HTMLElement>('[data-verdict="b"]');
        return v !== null && Number(getComputedStyle(v).opacity) > 0.9;
      },
      undefined,
      { timeout: 15_000 },
    );
    await context.close();
  });
});

test("with reduced motion the scene stands still and loads no animation runtime", async () => {
  const { context, page } = await visit("desktop", "/", true);
  const loaded: string[] = [];
  page.on("request", (r) => /\/rive\/|gsap/.test(r.url()) && loaded.push(r.url()));
  await page.waitForTimeout(800);
  const opacities = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-verdict]")].map((v) =>
      Number(getComputedStyle(v).opacity),
    ),
  );
  expect(opacities).toEqual([1, 1]);
  expect(loaded.filter((u) => u.includes("/rive/"))).toEqual([]);
  await context.close();
});

const later = () => new Date(Date.now() + 86_400_000).toISOString();
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

/** The card the compiler returns for the repo's demo mandate, rendered by the real renderer. */
async function demoCompiled() {
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
  return { mandateDraft: demo, card, ambiguous: [], check: { status: "ok", discrepancies: null } };
}

/** A signed-in buyer whose API answers come from `answer`; anything else is refused. */
async function signedIn(
  kind: keyof typeof VIEWPORTS,
  path: string,
  answer: (path: string, body: string | null) => unknown | Promise<unknown>,
) {
  const context = await browser.newContext(VIEWPORTS[kind]);
  await context.route("https://api.keelson.finance/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const headers = {
      "access-control-allow-origin": base,
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "content-type, idempotency-key, keelson-device",
    };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const value =
      url.pathname === "/api/auth/get-session"
        ? SESSION()
        : await answer(url.pathname, req.postData());
    if (value === undefined) return route.abort("connectionrefused");
    if (value instanceof Uint8Array) {
      return route.fulfill({
        headers,
        contentType: "application/scitt-statement+cose",
        body: Buffer.from(value),
      });
    }
    return route.fulfill({ headers, contentType: "application/json", body: JSON.stringify(value) });
  });
  const page = await context.newPage();
  await page.goto(`${base}${path}`);
  return { context, page };
}

describe.each(Object.keys(VIEWPORTS) as (keyof typeof VIEWPORTS)[])("rules on %s", (kind) => {
  test("the controls write the request, and the read card seals with who answers", async () => {
    const compiled = await demoCompiled();
    let prompt = "";
    const { context, page } = await signedIn(kind, "/new/", (path, body) => {
      if (path === "/v1/passkeys") {
        return {
          passkeys: [
            {
              id: "pk_1",
              name: "Keelson",
              credentialId: "cred-1",
              createdAt: new Date().toISOString(),
            },
          ],
        };
      }
      if (path === "/v1/mandates/compile") {
        prompt = (JSON.parse(body ?? "{}") as { prompt: string }).prompt;
        return compiled;
      }
      return undefined;
    });
    await page.getByRole("heading", { level: 1, name: "What may your agent buy?" }).waitFor();
    await page.getByRole("button", { name: "Running shoes, size 10" }).click();
    await page.getByRole("button", { name: "$50", exact: true }).click();
    await page.getByLabel("Store name").fill("RunFast");
    // The radios are visually hidden behind their segmented labels.
    await page.getByRole("radio", { name: "Today" }).check({ force: true });
    // Let the pressed chips finish their color transition before measuring contrast.
    await page.waitForTimeout(300);
    const { violations } = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(",")}`)).toEqual([]);

    await page.getByRole("button", { name: "Review rules" }).click();
    await page.getByRole("heading", { level: 1, name: "Check it, then sign" }).waitFor();
    expect(prompt).toMatch(
      /^Running shoes, size 10, under \$50, from RunFast, by \w{3}, \w{3} \d+$/,
    );
    const answers = page.getByRole("list", { name: "Who answers for each part" });
    expect(await answers.getByText("Keelson checks").count()).toBe(1);
    expect(await answers.getByText("Agent's bond covers").count()).toBe(1);
    expect(await answers.getByText("Up to you").count()).toBe(1);
    await page.getByRole("button", { name: "Sign · up to $100.00" }).waitFor({ timeout: 30_000 });
    await context.close();
  });

  test("any store by card signs a card mandate the buyer reads back", async () => {
    const compiled = await demoCompiled();
    const { context, page } = await signedIn(kind, "/new/", (path) => {
      if (path === "/v1/passkeys") {
        return {
          passkeys: [
            {
              id: "pk_1",
              name: "Keelson",
              credentialId: "cred-1",
              createdAt: new Date().toISOString(),
            },
          ],
        };
      }
      return path === "/v1/mandates/compile" ? compiled : undefined;
    });
    await page.getByRole("heading", { level: 1, name: "What may your agent buy?" }).waitFor();
    await page.getByRole("button", { name: "Coffee beans, whole" }).click();
    await page.getByRole("radio", { name: "Any store (PayPal card)" }).check({ force: true });
    await page.getByText("Paid with PayPal · Keelson single-use card.").waitFor();
    await page.getByRole("button", { name: "Review rules" }).click();
    await page.getByRole("button", { name: "Sign · up to $100.00" }).waitFor({ timeout: 30_000 });
    expect(await page.getByText("Any store · card").first().isVisible()).toBe(true);
    const answers = page.getByRole("list", { name: "Who answers for each part" });
    expect(await answers.getByText(/Paid with/).count()).toBe(1);
    const { violations } = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    await context.close();
  });
});

describe.each(Object.keys(VIEWPORTS) as (keyof typeof VIEWPORTS)[])("home on %s", (kind) => {
  test("says what the agent bought, what Keelson blocked and who answers", async () => {
    const { card } = await demoCompiled();
    const id = "01M7MANDATE000000000000000";
    const now = new Date().toISOString();
    const { context, page } = await signedIn(kind, "/", (path) => {
      if (path === "/v1/mandates") {
        return {
          mandates: [
            {
              id,
              state: "ACTIVE",
              budget: { currency: "USD", maxMinor: "10000", remainingMinor: "1100" },
              merchantIds: ["mrc_runfast"],
              holdMode: "mandate",
              expiresAt: later(),
              createdAt: now,
            },
          ],
        };
      }
      if (path === `/v1/mandates/${id}`) {
        return {
          id,
          state: "ACTIVE",
          mandateHash: null,
          budget: { currency: "USD", maxMinor: "10000", remainingMinor: "1100" },
          expiresAt: later(),
          hold: null,
          card,
          purchases: [
            {
              id: "p1",
              merchantId: "mrc_runfast",
              amount: { currency: "USD", minor: "8900" },
              createdAt: now,
              state: "CAPTURED",
              mode: "2of2",
              checks: [{ field: "total", mandate: "$100.00", cart: "$89.00", pass: true }],
              disputes: [],
            },
            {
              id: "p2",
              merchantId: "mrc_runfast",
              amount: { currency: "USD", minor: "34000" },
              createdAt: now,
              state: "DENIED",
              mode: "2of2",
              blocked: ["total"],
              reasons: [{ field: "total", mandate: "$100.00", cart: "$340.00" }],
              disputes: [],
            },
          ],
          pendingHolds: [],
        };
      }
      return undefined;
    });
    await page.getByText("Keelson blocked 1 cart").waitFor();
    expect(await page.getByText("$11", { exact: false }).count()).toBeGreaterThan(0);
    const activity = page.getByRole("region", { name: "Activity" });
    expect(await activity.getByRole("link").count()).toBe(2);
    expect(await activity.getByText("$89.00 ≤ $100.00 ✓").count()).toBe(1);
    await activity.getByRole("tab", { name: /Blocked/ }).click();
    expect(await activity.getByRole("link").count()).toBe(1);
    expect(await activity.getByText("Cart $340.00 · max $100.00").count()).toBe(1);
    expect(await page.getByRole("list", { name: "Who answers for each part" }).count()).toBe(1);
    const { violations } = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(",")}`)).toEqual([]);
    await context.close();
  });

  test("a first-time buyer goes on to set the rules", async () => {
    const { context, page } = await signedIn(kind, "/", (path) => {
      if (path === "/v1/mandates") return { mandates: [] };
      if (path === "/v1/passkeys") return { passkeys: [] };
      return undefined;
    });
    await page.waitForURL(`${base}/new/`);
    await page.getByRole("heading", { level: 1, name: "What may your agent buy?" }).waitFor();
    await context.close();
  });
});

/** A mandate view in `state`, built on the demo card. */
async function viewIn(id: string, state: string, purchases: unknown[] = []) {
  const { card } = await demoCompiled();
  return {
    id,
    state,
    mandateHash: null,
    budget: { currency: "USD", maxMinor: "10000", remainingMinor: "10000" },
    expiresAt: later(),
    hold: null,
    card,
    purchases,
    pendingHolds: [],
  };
}

describe("signing and going live", () => {
  test("a brand-new buyer creates a passkey before the rules are read, and can go back", async () => {
    // The API compiles only for a buyer with a passkey, since the mandate names it.
    let compiles = 0;
    const { context, page } = await signedIn("desktop", "/new/", (path) => {
      if (path === "/v1/passkeys") return { passkeys: [] };
      if (path === "/v1/mandates/compile") {
        compiles++;
        return undefined;
      }
      return undefined;
    });
    await page.getByRole("button", { name: "Running shoes, size 10" }).click();
    await page.getByRole("button", { name: "Review rules" }).click();
    await page.getByRole("heading", { level: 1, name: "Sign with Face ID" }).waitFor();
    expect(await page.getByRole("button", { name: "Create passkey" }).isEnabled()).toBe(true);
    expect(compiles).toBe(0);
    await page.getByRole("button", { name: "Back" }).click();
    await page.getByRole("heading", { level: 1, name: "What may your agent buy?" }).waitFor();
    expect(
      await page
        .getByRole("button", { name: "Running shoes, size 10" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await context.close();
  });

  test("a signed mandate asks for the PayPal hold, then says the agent is live", async () => {
    const id = "01M7MANDATE000000000000001";
    let state = "SIGNED";
    const { context, page } = await signedIn("desktop", `/new/?hold=${id}`, (path) =>
      path === `/v1/mandates/${id}` ? viewIn(id, state) : undefined,
    );
    await page.getByRole("heading", { level: 1, name: "Hold $100.00 on PayPal" }).waitFor();
    const { violations } = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    state = "ACTIVE";
    await page.reload();
    await page.getByRole("heading", { level: 1, name: "Your agent is live" }).waitFor();
    expect(await page.getByRole("list", { name: "All steps done" }).count()).toBe(1);
    expect(await page.getByRole("link", { name: "Go home" }).getAttribute("href")).toBe("/");
    await context.close();
  });
});

describe("home actions", () => {
  const id = "01M7MANDATE000000000000002";
  const summary = (state: string) => ({
    mandates: [
      {
        id,
        state,
        budget: { currency: "USD", maxMinor: "10000", remainingMinor: "10000" },
        merchantIds: ["mrc_runfast"],
        holdMode: "mandate",
        expiresAt: later(),
        createdAt: new Date().toISOString(),
      },
    ],
  });

  test("a mandate waiting for its hold shows the setup step that is left", async () => {
    const { context, page } = await signedIn("mobile", "/", async (path) => {
      if (path === "/v1/mandates") return summary("SIGNED");
      if (path === `/v1/mandates/${id}`) return viewIn(id, "SIGNED");
      return undefined;
    });
    const setup = page.getByRole("link", { name: /Finish setup · 3 of 4/ });
    await setup.waitFor();
    expect(await setup.getAttribute("href")).toBe(`/new/?hold=${id}`);
    expect(await page.getByRole("button", { name: "Stop your agent" }).count()).toBe(0);
    await context.close();
  });

  test("stopping the agent takes a held key, not a tap", async () => {
    let revoked = 0;
    const { context, page } = await signedIn("desktop", "/", async (path) => {
      if (path === "/v1/mandates") return summary("ACTIVE");
      if (path === `/v1/mandates/${id}`) return viewIn(id, revoked ? "REVOKED" : "ACTIVE");
      if (path === `/v1/mandates/${id}/revoke`) {
        revoked++;
        return { id, state: "REVOKED" };
      }
      return undefined;
    });
    const stop = page.getByRole("button", { name: "Stop your agent" });
    await stop.click();
    await page.waitForTimeout(300);
    expect(revoked).toBe(0);
    await stop.focus();
    await page.keyboard.down("Space");
    await page.waitForTimeout(1_400);
    await page.keyboard.up("Space");
    await expect.poll(() => revoked).toBe(1);
    await stop.waitFor({ state: "detached" });
    await context.close();
  });
});

describe("receipts and disputes", () => {
  const id = "01M7MANDATE000000000000003";
  const bought = {
    id: "01M7PURCHASE00000000000003",
    merchantId: "mrc_runfast",
    amount: { currency: "USD", minor: "8900" },
    createdAt: new Date().toISOString(),
    state: "CAPTURED",
    mode: "2of2",
    logIndex: "12",
    checks: [
      { field: "total", mandate: "$100.00", cart: "$89.00", pass: true },
      { field: "variant", mandate: "size_us 10", cart: "size_us 10", pass: true },
    ],
    disputes: [] as { id: string; state: string }[],
  };

  test("a bought order says who answers for the wrong part and where to dispute it", async () => {
    const { context, page } = await signedIn(
      "desktop",
      `/purchase/?mandate=${id}&id=${bought.id}`,
      (path) => (path === `/v1/mandates/${id}` ? viewIn(id, "ACTIVE", [bought]) : undefined),
    );
    const checks = page.getByRole("list", { name: "What Keelson checked" });
    await checks.waitFor();
    expect(
      await page.getByRole("list", { name: "What happened" }).getByText("$89.00 paid").count(),
    ).toBe(1);
    expect(await checks.getByRole("listitem").count()).toBe(2);
    expect(await checks.getByRole("listitem").first().textContent()).toMatch(
      /\$89\.00\s+within\s+\$100\.00/,
    );
    await page.getByRole("button", { name: /Not what you asked for/ }).click();
    await page.getByRole("heading", { name: "What happened?" }).waitFor();
    for (const kind of ["I don't remember it", "Not what I meant", "The agent went rogue"]) {
      expect(await page.getByRole("dialog").getByText(kind).count()).toBe(1);
    }
    await page.getByRole("dialog").getByText("The agent got it wrong").click();
    await page.getByRole("dialog").getByText("Variant", { exact: true }).click();
    await page.getByText("The agent's operator answers for this, from its bond.").waitFor();
    expect(await page.getByRole("link", { name: /Open on PayPal/ }).getAttribute("href")).toBe(
      "https://www.sandbox.paypal.com/resolutioncenter",
    );
    const { violations } = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    await context.close();
  });

  test("a card purchase shows its card, each charge and what both enclaves decided", async () => {
    const at = new Date().toISOString();
    const charge = {
      currency: "USD",
      mcc: "5814",
      merchantName: "BLUE HARBOR COFFEE",
      merchantCountry: "US",
      legs: { tdx: true, nitro: true },
      reason: null,
      at,
    };
    const paid = {
      ...bought,
      id: "01M7PURCHASE00000000000009",
      merchantId: "*",
      amount: { currency: "USD", minor: "450" },
      card: {
        issuer: "lithic",
        lastFour: "4242",
        state: "CLOSED",
        expiresAt: later(),
        controls: { spend_limit_minor: "450", mcc: ["5814", "5499"], countries: ["US"] },
        settledMinor: "450",
        chargebacks: [],
        bondClaimMinor: "450",
        authorizations: [
          {
            ...charge,
            id: "a1",
            amountMinor: "450",
            approved: true,
            failedMask: 0,
            latencyMs: 212,
          },
          {
            ...charge,
            id: "a2",
            amountMinor: "450",
            approved: false,
            failedMask: 256,
            latencyMs: 41,
          },
          {
            ...charge,
            id: "a3",
            amountMinor: "9900",
            mcc: "5812",
            approved: false,
            failedMask: 48,
            latencyMs: 188,
          },
        ],
      },
    };
    for (const kind of ["desktop", "mobile"] as const) {
      const { context, page } = await signedIn(
        kind,
        `/purchase/?mandate=${id}&id=${paid.id}`,
        (path) => (path === `/v1/mandates/${id}` ? viewIn(id, "ACTIVE", [paid]) : undefined),
      );
      const charges = page.getByRole("list", { name: "Charges on this card" });
      await charges.waitFor();
      expect(
        await page
          .getByRole("heading", { name: "Paid with PayPal · Keelson single-use card" })
          .count(),
      ).toBe(1);
      expect(await charges.getByRole("listitem").count()).toBe(3);
      expect(await charges.getByText("Both enclaves approved the charge").count()).toBe(1);
      expect(
        await charges.getByText("Declined: a second charge on a single-use card").count(),
      ).toBe(1);
      expect(
        await charges
          .getByText(
            "Declined: more than the countersigned total; a kind of store the mandate does not allow",
          )
          .count(),
      ).toBe(1);
      expect(
        await page
          .getByRole("list", { name: "What happened" })
          .getByText(/BLUE HARBOR COFFEE charged \$4\.50; both enclaves approved it in 212 ms/)
          .count(),
      ).toBe(1);
      expect(await page.getByText("BLUE HARBOR COFFEE", { exact: true }).first().isVisible()).toBe(
        true,
      );
      const { violations } = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
      await context.close();
    }
  });

  test("a card purchase is charged back through the issuer, with the Alibi as evidence", async () => {
    const filedBack = {
      id: "dsp_1",
      reason: "not_as_described",
      networkCodes: { visa: "13.3", mastercard: "4853" },
      amountMinor: "450",
      status: "SUBMITTED",
      resolution: null,
      recoveredMinor: null,
      evidenceUploaded: true,
    };
    let filed = false;
    const card = (chargebacks: unknown[], bondClaimMinor: string) => ({
      issuer: "lithic",
      lastFour: "4242",
      state: "CLOSED",
      expiresAt: later(),
      controls: { spend_limit_minor: "450", mcc: ["5814"], countries: ["US"] },
      settledMinor: "450",
      chargebacks,
      bondClaimMinor,
      authorizations: [],
    });
    const paid = () => ({
      ...bought,
      id: "01M7PURCHASE00000000000010",
      merchantId: "*",
      amount: { currency: "USD", minor: "450" },
      card: filed ? card([filedBack], "0") : card([], "450"),
    });
    const { context, page } = await signedIn(
      "desktop",
      `/purchase/?mandate=${id}&id=01M7PURCHASE00000000000010`,
      (path) => {
        if (path === `/v1/mandates/${id}`) return viewIn(id, "ACTIVE", [paid()]);
        if (path === "/v1/alibis/01M7PURCHASE00000000000010.cose") return statementOf(v2Bundle());
        if (path === "/v1/purchases/01M7PURCHASE00000000000010/chargeback") {
          filed = true;
          return filedBack;
        }
        return undefined;
      },
    );
    await page.getByRole("button", { name: /Not what you asked for/ }).click();
    await page.getByRole("heading", { name: "Charge it back" }).waitFor();
    expect(await page.getByText("Visa 10.4 · Mastercard 4837").count()).toBe(1);
    expect(
      await page
        .getByRole("dialog")
        .getByText("01M7PURCHASE00000000000010.cose, inside the PDF")
        .count(),
    ).toBe(1);
    await page.getByRole("button", { name: "File the chargeback" }).click();
    const list = page.getByRole("list", { name: "Chargebacks" });
    await list.waitFor();
    expect(await list.getByText(/Alibi attached as evidence/).count()).toBe(1);
    expect(await list.getByText(/bond can still pay at most \$0\.00/).count()).toBe(1);
    await context.close();
  });

  test("a SCITT Alibi shows its statement, where the log holds it, and downloads it", async () => {
    const cose = statementOf(v2Bundle());
    const { context, page } = await signedIn(
      "desktop",
      `/purchase/?mandate=${id}&id=${bought.id}`,
      (path) =>
        path === `/v1/mandates/${id}`
          ? viewIn(id, "ACTIVE", [bought])
          : path === `/v1/alibis/${bought.id}.cose`
            ? cose
            : undefined,
    );
    const panel = page.locator("[data-standards]");
    await panel.waitFor();
    expect(await panel.getByText("IETF SCITT transparent statement").count()).toBe(1);
    expect(await panel.getByText("Entry 1 of 4").count()).toBe(1);
    const [file] = await Promise.all([
      page.waitForEvent("download"),
      panel.getByRole("button", { name: "Download statement (.cose)" }).click(),
    ]);
    expect(file.suggestedFilename()).toBe(`${bought.id}.cose`);
    expect(new Uint8Array(await readFile((await file.path()) as string))).toEqual(cose);
    expect(await panel.getByRole("link", { name: "Verify anywhere" }).getAttribute("href")).toMatch(
      new RegExp(
        `^https://verify\\.keelson\\.finance/a/${bought.id}#[A-Za-z0-9_-]{43}\\.0\\.421614$`,
      ),
    );
    const { violations } = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    await context.close();
  });

  test("a v1 Alibi shows no SCITT panel", async () => {
    const { context, page } = await signedIn(
      "desktop",
      `/purchase/?mandate=${id}&id=${bought.id}`,
      (path) => (path === `/v1/mandates/${id}` ? viewIn(id, "ACTIVE", [bought]) : undefined),
    );
    await page.getByRole("link", { name: "Verify in your browser" }).waitFor();
    expect(await page.locator("[data-standards]").count()).toBe(0);
    await context.close();
  });

  test("a receipt lists the parts of a total with tax and shipping", async () => {
    const taxed = {
      ...bought,
      amount: {
        currency: "USD",
        minor: "9612",
        breakdown: { items: "8900", tax: "712", shipping: "500", discount: "500" },
      },
    };
    const { context, page } = await signedIn(
      "mobile",
      `/purchase/?mandate=${id}&id=${bought.id}`,
      (path) => (path === `/v1/mandates/${id}` ? viewIn(id, "ACTIVE", [taxed]) : undefined),
    );
    const ledger = page.getByRole("region", { name: "Checkout total" });
    await ledger.waitFor();
    const labels = await ledger.locator("dt").allTextContents();
    const figures = await ledger.locator("dd .sr-only").allTextContents();
    expect(labels.map((l, i) => `${l} ${figures[i]}`)).toEqual([
      "Items $89.00",
      "Tax $7.12",
      "Shipping $5.00",
      "Discount −$5.00",
      "Total $96.12",
    ]);
    const { violations } = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    await context.close();
  });

  test("the disputes list shows every dispute, and says so when there is none", async () => {
    const disputed = { ...bought, disputes: [{ id: "PP-D-1234", state: "OPEN" }] };
    for (const [purchases, expectText] of [
      [[disputed], "PP-D-1234"],
      [[bought], "No disputes"],
    ] as const) {
      const { context, page } = await signedIn("mobile", "/disputes/", (path) => {
        if (path === "/v1/mandates") {
          return {
            mandates: [
              {
                id,
                state: "ACTIVE",
                budget: { currency: "USD", maxMinor: "10000", remainingMinor: "1100" },
                merchantIds: ["mrc_runfast"],
                holdMode: "mandate",
                expiresAt: later(),
                createdAt: new Date().toISOString(),
              },
            ],
          };
        }
        if (path === `/v1/mandates/${id}`) return viewIn(id, "ACTIVE", [...purchases]);
        return undefined;
      });
      await page.getByText(expectText, { exact: false }).first().waitFor();
      await context.close();
    }
  });
});

test("keyboard focus is visible", async () => {
  const { context, page } = await visit("desktop");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const outline = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    return getComputedStyle(el).outlineStyle;
  });
  expect(outline).not.toBe("none");
  await context.close();
});

test("a signed-out visitor who opens the mandate form is sent to the welcome", async () => {
  const { context, page } = await visit("desktop", "/new/");
  await page.waitForURL(`${base}/`);
  await context.close();
});

test("a signed-out visitor who opens the passkeys is sent to the welcome", async () => {
  const { context, page } = await visit("desktop", "/passkeys/");
  await page.waitForURL(`${base}/`);
  await context.close();
});

test("the welcome stays inside its budgets", async () => {
  const html = await readFile(join(out, "index.html"), "utf8");
  const assets = [...new Set(html.match(/\/_next\/static\/[^"]+\.(js|css)/g) ?? [])];
  const gz = async (ext: string) => {
    let total = 0;
    for (const a of assets.filter((x) => x.endsWith(ext))) {
      total += gzipSync(await readFile(join(out, a))).length;
    }
    return total;
  };
  const js = await gz(".js");
  const css = await gz(".css");
  const riv = (await stat(join(out, "rive/states.riv"))).size;

  const { context, page } = await visit("mobile");
  const lcp = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        new PerformanceObserver((list) => {
          const last = list.getEntries().at(-1);
          resolve(last ? last.startTime : 0);
        }).observe({ type: "largest-contentful-paint", buffered: true });
      }),
  );
  await context.close();
  console.info(
    JSON.stringify({
      firstLoadJsGzip: js,
      cssGzip: css,
      statesRiv: riv,
      lcpMsLocal: Math.round(lcp),
    }),
  );
  expect(js).toBeLessThan(230_000);
  expect(css).toBeLessThan(18_000);
  expect(riv).toBeLessThan(16_000);
  expect(lcp).toBeLessThan(1_800);
});

test("render.yaml serves the app's Content-Security-Policy", async () => {
  const blueprint = parse(
    await readFile(new URL("../../../../render.yaml", import.meta.url), "utf8"),
  ) as {
    services: { name: string; headers?: { path: string; name: string; value: string }[] }[];
  };
  const web = blueprint.services.find((s) => s.name === "keelson-web");
  expect(web?.headers?.find((h) => h.name === "Content-Security-Policy")?.value).toBe(CSP);
});

test("the CSP holds: no violation while the scene plays", async () => {
  const { context, page } = await visit("desktop");
  const violations: string[] = [];
  page.on(
    "console",
    (m) => m.text().includes("Content Security Policy") && violations.push(m.text()),
  );
  await verdictShown(page);
  expect(violations).toEqual([]);
  await context.close();
});

test("the first paint is the welcome, before any script or session read", async () => {
  const html = await readFile(join(out, "index.html"), "utf8");
  expect(html).toContain("Connect your PayPal");
  expect(html).not.toContain("Loading…");
});

const VISITOR_VIEWS = [
  ["merchant/", "Merchant console", "Checking your session"],
  ["operator/", "Operator console", "Checking your session"],
  ["judge/", "Judge Mode", "Opening Judge Mode"],
] as const;

test.each(VISITOR_VIEWS)(
  "the first paint of /%s is what a visitor sees",
  async (path, h1, wait) => {
    const html = await readFile(join(out, path, "index.html"), "utf8");
    expect(html).toContain(h1);
    expect(html).not.toContain(wait);
  },
);

test.each(VISITOR_VIEWS)(
  "a visitor on /%s calls no signed-in route and logs no error",
  async (path, h1) => {
    const context = await browser.newContext();
    const calls: string[] = [];
    await context.route("https://api.keelson.finance/**", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/auth/get-session") {
        return route.fulfill({ status: 200, contentType: "application/json", body: "null" });
      }
      calls.push(url.pathname);
      return route.abort("connectionrefused");
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/${path}`);
    await page.getByRole("heading", { level: 1, name: h1 }).waitFor();
    await page.waitForLoadState("networkidle");
    expect(calls.filter((p) => p.startsWith("/v1/"))).toEqual([]);
    expect(errors).toEqual([]);
    await context.close();
  },
);

test("a missing page says so on the brand, in light and dark", async () => {
  const html = await readFile(join(out, "404.html"), "utf8");
  expect(html).not.toContain("next-error-h1");
  for (const colorScheme of ["light", "dark"] as const) {
    const context = await browser.newContext({ colorScheme });
    await context.route("https://api.keelson.finance/**", (route) =>
      route.abort("connectionrefused"),
    );
    const page = await context.newPage();
    await page.goto(`${base}/404.html`);
    await page.getByRole("heading", { level: 1, name: "This page does not exist" }).waitFor();
    expect(await page.getByRole("link", { name: "Go to the app" }).getAttribute("href")).toBe("/");
    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
      .analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    await context.close();
  }
});

test("mobile pages never scroll sideways", async () => {
  const { context, page } = await visit("mobile");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await context.close();
});

const rate = (method: string, k: number, n: number, lo: number, hi: number) => ({
  method,
  k,
  n,
  ppm: n === 0 ? null : Math.round((k * 1e6) / n),
  lo_ppm: lo,
  hi_ppm: hi,
});

/** A scoreboard in the API's shape: two backbones and the pooled rows. */
function board(id: string, attacks: number, complete: boolean) {
  const rows = ["vulnerable", "guarded", "all"].flatMap((backbone) =>
    (["seen", "holdout", "all"] as const).map((split) => ({
      backbone,
      split,
      models: backbone === "all" ? [] : [`model-${backbone}`],
      attacks,
      proposed: attacks - 1,
      asr: rate("wilson", 1, attacks - 1, 10_000, 400_000),
      escape: rate("clopper-pearson", 0, 237, 0, 15_446),
      false_blocks: rate("wilson", 0, 640, 0, 5_964),
      utility: rate("wilson", 2, attacks, 50_000, 600_000),
      amber: { k: 1, n: attacks - 1, ppm: 100_000 },
      usd_micros: 1_000_000,
    })),
  );
  return {
    v: "keelson.scoreboard/1",
    campaign: id,
    started: "2026-11-10T12:00:00.000Z",
    commit: "76c8620abcdef",
    lines: attacks + 2,
    head: "ab".repeat(32),
    complete,
    attacks,
    mutator_usd_micros: complete ? 760_000 : null,
    rows,
  };
}

/** The scoreboard against the API's public red-team routes, answered from this test. */
async function scoreboardVisit(kind: keyof typeof VIEWPORTS, live: boolean) {
  const id = "01M72AN4VSH4FYYT9X7RF01P3N";
  const context = await browser.newContext(VIEWPORTS[kind]);
  await context.route("https://api.keelson.finance/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) =>
      route.fulfill({ json: body, headers: { "access-control-allow-origin": "*" } });
    if (path === "/v1/redteam/campaigns") {
      return json({
        campaigns: [
          { id, startedAt: "2026-11-10T12:00:00.000Z", finishedAt: null, attacks: 10 },
          {
            id: "01M72AKHZ75KJSNS17AA9BJTJY",
            startedAt: "2026-11-10T11:00:00.000Z",
            finishedAt: "2026-11-10T11:10:00.000Z",
            attacks: 22,
          },
        ],
      });
    }
    if (path.endsWith("/scoreboard")) return json(board(id, 10, !live));
    if (path.endsWith("/scoreboard/stream")) {
      return route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
        body: `event: scoreboard\ndata: ${JSON.stringify(board(id, 1008, true))}\n\nevent: end\ndata: \n\n`,
      });
    }
    return route.abort("connectionrefused");
  });
  const page = await context.newPage();
  await page.goto(`${base}/scoreboard/`);
  await page.getByRole("heading", { level: 1 }).waitFor();
  return { context, page };
}

describe.each(Object.keys(VIEWPORTS) as (keyof typeof VIEWPORTS)[])("scoreboard on %s", (kind) => {
  test("shows the published numbers, the ledger and no accessibility violations", async () => {
    const { context, page } = await scoreboardVisit(kind, false);
    await page.getByText("0 of 237").first().waitFor();
    expect(await page.getByRole("link", { name: "Download ledger" }).getAttribute("href")).toBe(
      "https://api.keelson.finance/v1/redteam/campaigns/01M72AN4VSH4FYYT9X7RF01P3N/ledger",
    );
    expect(await page.getByText("≤ 1.55% at 95% · Clopper-Pearson").count()).toBeGreaterThan(0);
    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
      .analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    // On a phone the layout viewport grows to fit wide content, so compare with the screen.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= screen.width)).toBe(
      true,
    );
    await context.close();
  });
});

test("a running campaign's scoreboard follows the stream until it ends", async () => {
  const { context, page } = await scoreboardVisit("desktop", true);
  await page.getByText("Finished").waitFor();
  await page.getByText("1,008 attacks").first().waitFor();
  await context.close();
});

test("the methodology states every denominator and how to recompute", async () => {
  const { context, page } = await visit("desktop", "/scoreboard/methodology/");
  await expect(page.getByRole("heading", { level: 1 }).textContent()).resolves.toBe(
    "How the red-team scoreboard is measured",
  );
  for (const metric of ["Agent ASR", "Escape rate", "False blocks", "Utility under attack"]) {
    expect(await page.getByText(metric, { exact: true }).count()).toBe(1);
  }
  expect(
    await page.getByText("services/redteam/scripts/scoreboard.ts", { exact: false }).count(),
  ).toBe(1);
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  await context.close();
});

test("a blocked cart shows, field by field, what the mandate allowed against the cart", async () => {
  const context = await browser.newContext();
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 86_400_000).toISOString();
  const [mandateId, purchaseId] = ["01M7MANDATE000000000000000", "01M7PURCHASE00000000000000"];
  await context.route("https://api.keelson.finance/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (value: unknown) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/api/auth/get-session") {
      return json({
        session: {
          id: "s",
          userId: "u",
          token: "t",
          expiresAt: later,
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
      });
    }
    if (path === `/v1/mandates/${mandateId}`) {
      return json({
        id: mandateId,
        state: "ACTIVE",
        mandateHash: null,
        budget: { currency: "USD", maxMinor: "10000", remainingMinor: "10000" },
        expiresAt: later,
        hold: null,
        card: {
          rows: [
            {
              field: "total",
              label: "Total",
              values: ["≤ $100.00"],
              color: "green",
              answers: "Keelson",
            },
            {
              field: "items",
              label: "Items",
              values: ["Running shoes"],
              color: "green",
              answers: "Keelson",
            },
          ],
          warnings: [],
        },
        purchases: [
          {
            id: purchaseId,
            merchantId: "runfast",
            amount: { currency: "USD", minor: "34000" },
            createdAt: now,
            state: "DENIED",
            mode: "2of2",
            blocked: ["total", "items"],
            reasons: [
              { field: "total", mandate: "$100.00", cart: "$340.00" },
              { field: "items", mandate: "Running shoes", cart: "Trail sandals" },
            ],
            disputes: [],
          },
        ],
        pendingHolds: [],
      });
    }
    return route.abort("connectionrefused");
  });
  const page = await context.newPage();
  await page.goto(`${base}/purchase/?mandate=${mandateId}&id=${purchaseId}`);
  await page.getByText("blocked the cart before payment").waitFor();
  const lines = page.locator('[data-slot="block-diff"]');
  expect(await lines.count()).toBe(2);
  expect(await lines.nth(0).innerText()).toMatch(/Mandate \$100\.00[\s\S]*Cart \$340\.00/);
  expect(await lines.nth(1).innerText()).toMatch(/Mandate Running shoes[\s\S]*Cart Trail sandals/);
  await context.close();
});

test("a captured purchase shows its anonymous proof, read from the live API", async () => {
  const context = await browser.newContext();
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 86_400_000).toISOString();
  // A sandbox purchase whose C1 and C3 proofs were composed; the session and mandate are local.
  const [mandateId, purchaseId] = ["01M7MANDATE000000000000000", "01M73AGWP5EJSW35XE6Q090MCH"];
  await context.route("https://api.keelson.finance/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (value: unknown) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
    if (path.startsWith("/v1/anonymous-purchases/") || path.startsWith("/v1/user-set/roots/")) {
      const live = await route.fetch();
      return route.fulfill({
        status: live.status(),
        contentType: "application/json",
        body: await live.text(),
      });
    }
    if (path === "/api/auth/get-session") {
      return json({
        session: {
          id: "s",
          userId: "u",
          token: "t",
          expiresAt: later,
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
      });
    }
    if (path === `/v1/mandates/${mandateId}`) {
      return json({
        id: mandateId,
        state: "ACTIVE",
        mandateHash: null,
        budget: { currency: "USD", maxMinor: "10000", remainingMinor: "9900" },
        expiresAt: later,
        hold: null,
        card: { rows: [], warnings: [] },
        purchases: [
          {
            id: purchaseId,
            merchantId: "runfast",
            amount: { currency: "USD", minor: "100" },
            createdAt: "2026-11-10T18:11:32Z",
            state: "CAPTURED",
            mode: "2of2",
            logIndex: "783",
            disputes: [],
          },
        ],
        pendingHolds: [],
      });
    }
    return route.abort("connectionrefused");
  });
  const page = await context.newPage();
  await page.goto(`${base}/purchase/?mandate=${mandateId}&id=${purchaseId}`);
  await page.locator("[data-anonymous-proof=proven]").waitFor();
  await page.getByText("you are one of 125 users").waitFor();
  expect(
    await page.getByRole("link", { name: "Verify the anonymous proof" }).getAttribute("href"),
  ).toBe(`https://verify.keelson.finance/a/${purchaseId}?proof=anonymous`);
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  await context.close();
});
