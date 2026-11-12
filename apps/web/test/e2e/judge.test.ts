import AxeBuilder from "@axe-core/playwright";
import { type Browser, type BrowserContext, chromium, devices } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { serveOut } from "./static";

const API = "https://api.keelson.finance";
let site: Awaited<ReturnType<typeof serveOut>>;
let browser: Browser;

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

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

const note = (root: string) =>
  `log.keelson.finance/conformance/2026-1\n8\n${root}\n\n— log.keelson.finance/conformance/2026-1 ${"A".repeat(92)}=\n`;
/** A log bond slashed by the equivocation drill, with both signed checkpoints. */
const SLASHED_BOND = {
  chainId: 421614,
  address: `0x${"b8".repeat(20)}`,
  origin: "log.keelson.finance/conformance/2026-1",
  test: true,
  key: `0x${"ce".repeat(32)}`,
  owner: `0x${"11".repeat(20)}`,
  verifier: `0x${"22".repeat(20)}`,
  canonical: true,
  beneficiary: `0x${"33".repeat(20)}`,
  bountyBps: 1000,
  completionWindowSeconds: 86_400,
  balanceMinor: "0",
  withdrawalDelaySeconds: 604_800,
  withdrawal: null,
  equivocation: {
    prover: `0x${"44".repeat(20)}`,
    amountMinor: "70000",
    bountyMinor: "7000",
    provenAt: "2026-11-11T00:41:03.000Z",
    size: "8",
    rootA: `0x${"8c".repeat(32)}`,
    rootB: `0x${"0a".repeat(32)}`,
    noteA: note("jOVg1qZjazdB7Tj8rmWD+3QWGDDY3TyhORUctiQheD8="),
    noteB: note("ChqwfS8BauYyPx0+PcCcKXU0rv4BzXuNivf0X6gCOZs="),
    txHash: `0x${"55".repeat(32)}`,
    explorerUrl: `https://sepolia.arbiscan.io/tx/0x${"55".repeat(32)}`,
  },
  explorerUrl: `https://sepolia.arbiscan.io/address/0x${"b8".repeat(20)}`,
};

describe.each(Object.keys(VIEWPORTS) as (keyof typeof VIEWPORTS)[])("signed out on %s", (kind) => {
  for (const [path, heading] of [
    ["/judge/", "Judge Mode"],
    ["/status/", "Is Keelson up?"],
  ] as const) {
    test(`${path} says what is real and what is sandbox`, async () => {
      const context = await browser.newContext(VIEWPORTS[kind]);
      // With the API unreachable, both pages still render and say so.
      await context.route(`${API}/**`, (route) => route.abort("connectionrefused"));
      const page = await context.newPage();
      await page.goto(`${site.base}${path}`);
      await page.getByRole("heading", { level: 1, name: heading }).waitFor();
      await page.getByRole("cell", { name: "PayPal", exact: true }).waitFor();
      expect(await page.getByRole("cell", { name: "Sandbox" }).first().isVisible()).toBe(true);
      expect(await page.getByRole("cell", { name: "Testnet" }).first().isVisible()).toBe(true);
      if (path === "/judge/") {
        expect(await page.getByRole("button", { name: "Start Judge Mode" }).isEnabled()).toBe(true);
      }
      const { violations } = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await context.close();
    });
  }

  test("/status/ lets a keyboard scroll a slashed bond's signed checkpoints", async () => {
    const context = await browser.newContext(VIEWPORTS[kind]);
    await context.route(`${API}/**`, (route) => {
      if (new URL(route.request().url()).pathname !== "/v1/log/bonds") {
        return route.abort("connectionrefused");
      }
      return route.fulfill({
        headers: {
          "access-control-allow-origin": site.base,
          "access-control-allow-credentials": "true",
        },
        json: { bonds: [SLASHED_BOND] },
      });
    });
    const page = await context.newPage();
    await page.goto(`${site.base}/status/`);
    const checkpoint = page.getByRole("region", { name: "Checkpoint A" });
    await checkpoint.waitFor();
    expect(await checkpoint.evaluate((el) => el.tabIndex)).toBe(0);
    const { violations } = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    await context.close();
  });

  test("/status/ keeps its shape while the first report loads", async () => {
    const context = await browser.newContext(VIEWPORTS[kind]);
    // The live report, held back a moment so it lands after first paint.
    await context.route(`${API}/status`, async (route) => {
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.fulfill({ response });
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      (window as unknown as { cls: number }).cls = 0;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as unknown as { value: number }[]) {
          (window as unknown as { cls: number }).cls += e.value;
        }
      }).observe({ type: "layout-shift", buffered: true });
    });
    await page.goto(`${site.base}/status/`);
    await page.getByText(/^Checked /).waitFor();
    const cls = await page.evaluate(() => (window as unknown as { cls: number }).cls);
    expect(cls).toBeLessThan(0.1);
    await context.close();
  });
});

const DAY = 86_400_000;
const TOUR = {
  merchant_id: "mrc_runfast",
  agent_id: "351",
  mandate: {
    id: "01M7MANDATE000000000000000",
    state: "ACTIVE",
    mandate_hash: `0x${"ab".repeat(32)}`,
    budget: { currency: "USD", max_minor: "15000" },
    created_at: "2026-11-09T10:00:00.000Z",
    card: {
      rows: [
        {
          field: "total",
          label: "Maximum total",
          values: ["≤ $150.00"],
          color: "green",
          answers: "Keelson",
        },
        {
          field: "items",
          label: "Items",
          values: ["Running shoes"],
          color: "amber",
          answers: "Agent operator",
        },
      ],
      warnings: [],
    },
    purchases: [
      {
        id: "01M7CAPTURED00000000000000",
        state: "CAPTURED",
        mode: "2of2",
        amount: { currency: "USD", minor: "13900" },
        merchant_id: "mrc_runfast",
        created_at: "2026-11-09T10:05:00.000Z",
        log_index: "41",
        capture_id: "8MC585209K746392H",
        coverage_tx: `0x${"cd".repeat(32)}`,
        failure: null,
        checks: [{ field: "total", color: "green", pass: true }],
        alibi_fragment: null,
      },
      {
        id: "01M7DENIED0000000000000000",
        state: "DENIED",
        mode: "2of2",
        amount: { currency: "USD", minor: "34000" },
        merchant_id: "mrc_runfast",
        created_at: "2026-11-09T10:04:00.000Z",
        log_index: "40",
        capture_id: null,
        coverage_tx: null,
        failure: null,
        checks: [{ field: "total", color: "green", pass: false }],
        alibi_fragment: null,
      },
    ],
  },
  anonymous_purchase: null,
  dispute_id: "PP-D-27803",
  campaign_id: null,
};
const DISPUTE = {
  dispute_id: "PP-D-27803",
  purchase_id: "01M7CAPTURED00000000000000",
  state: "RESOLVED",
  reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
  received_at: "2026-11-09T11:00:00.000Z",
  attributed_at: "2026-11-09T11:00:41.000Z",
  elapsed_ms: 41_000,
  liable: "operator",
  verdict: { rule: "R03", digest: "0x00", chain_id: 421614, signatures: [] },
  settlement: null,
  // The public read: what was bought is left out.
  amber: {
    commitment: `0x${"1f".repeat(32)}`,
    attested: null,
    conviction: {
      field: "size",
      attested_value: null,
      proven_at: "2026-11-09T11:02:00.000Z",
      web_fact_digest: `0x${"ab".repeat(32)}`,
      captured_at: "2026-11-09T10:01:00.000Z",
      tx_hash: `0x${"cd".repeat(32)}`,
      explorer_url: `https://sepolia.arbiscan.io/tx/0x${"cd".repeat(32)}`,
      proof: { bytes: 7_616, hash: `0x${"ef".repeat(32)}`, public_inputs: [] },
    },
  },
};
const GRADE = {
  agentId: "351",
  grade: "A",
  computedAt: "2026-11-10T11:32:28.906Z",
  evidence: { coverages: 649, incidents: { total: 0 } },
  reserve: { warranties: 9 },
  frequency: { mean_ppm: 5101, upper95_ppm: 8378 },
  premium: { bps: 100 },
  bond: { requiredMinor: 13900 },
};

/** A judge's session and tour, answered from this test; the step to open is `step`. */
async function judgeTour(context: BrowserContext, now: string, step: number) {
  await context.route(`${API}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (value: unknown) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/api/auth/get-session") {
      return json({
        session: {
          id: "s",
          userId: "judge",
          token: "t",
          expiresAt: new Date(Date.now() + DAY).toISOString(),
          createdAt: now,
          updatedAt: now,
        },
        user: {
          id: "judge",
          name: "Judge",
          email: "judge@example.test",
          emailVerified: false,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
    if (path === "/v1/judge/tour") return json(TOUR);
    if (path === "/v1/disputes/PP-D-27803") return json(DISPUTE);
    if (path === "/v1/operators/351/grade") return json(GRADE);
    if (path === "/v1/log/bonds") return json({ bonds: [SLASHED_BOND] });
    return route.abort("connectionrefused");
  });
  await context.addInitScript((s) => {
    localStorage.setItem("keelson.session", "1");
    localStorage.setItem("keelson.judge.step", String(s));
  }, step);
}

describe.each(Object.keys(VIEWPORTS) as (keyof typeof VIEWPORTS)[])("touring on %s", (kind) => {
  test("the role switcher jumps between the shopper's, merchant's and operator's guided steps", async () => {
    const context = await browser.newContext(VIEWPORTS[kind]);
    const now = new Date().toISOString();
    await judgeTour(context, now, 0);
    const page = await context.newPage();
    const axe = async () => {
      const { violations } = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    };
    await page.goto(`${site.base}/judge/`);
    await page.getByRole("heading", { level: 1, name: "The mandate" }).waitFor();
    expect(
      await page.getByRole("button", { name: "Shopper", exact: true }).getAttribute("aria-pressed"),
    ).toBe("true");
    await axe();

    await page.getByRole("button", { name: "Next: The agent shops" }).click();
    await page.getByRole("heading", { level: 1, name: "The agent shops" }).waitFor();
    await page.getByText("Injected listing").waitFor();
    expect(await page.getByText("By both TEEs (2 of 2)").isVisible()).toBe(true);
    await axe();

    await page.getByRole("button", { name: "Merchant", exact: true }).click();
    await page.getByRole("heading", { level: 1, name: "A dispute arrives" }).waitFor();
    await page.getByText("PayPal dispute", { exact: true }).waitFor();
    await axe();

    await page.getByRole("button", { name: "Next: Verdict and settlement" }).click();
    await page.getByRole("heading", { level: 1, name: "Verdict and settlement" }).waitFor();
    const amber = page.getByRole("region", { name: "What the operator attested" });
    await amber.getByText("Proven false on chain").waitFor();
    expect(await amber.getByText("Size", { exact: true }).isVisible()).toBe(true);
    expect(
      await amber.getByRole("link", { name: /Conviction transaction/ }).getAttribute("href"),
    ).toBe(DISPUTE.amber.conviction.explorer_url);
    await axe();

    await page.getByRole("button", { name: "Operator", exact: true }).click();
    await page.getByRole("heading", { level: 1, name: "Operator grade" }).waitFor();
    await page.getByText("Covered purchases", { exact: true }).waitFor();
    expect(
      await page.getByRole("navigation", { name: "Tour steps" }).getByRole("button").count(),
    ).toBe(3);
    await axe();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await context.close();
  });
  test("the log step shows the slashed bond with its headings in order", async () => {
    const context = await browser.newContext(VIEWPORTS[kind]);
    await judgeTour(context, new Date().toISOString(), 4);
    const page = await context.newPage();
    await page.goto(`${site.base}/judge/`);
    await page.getByRole("heading", { level: 1, name: "Catch the log lying" }).waitFor();
    await page.getByRole("region", { name: "Checkpoint A" }).waitFor();
    const { violations } = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    await context.close();
  });
});

test("an invite link is forwarded once and leaves the address bar and the history", async () => {
  const invite = "invite-from-the-testing-instructions";
  const context = await browser.newContext(VIEWPORTS.desktop);
  const bodies: unknown[] = [];
  await context.route(`${API}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204 });
    if (request.url().endsWith("/v1/judge/sessions")) {
      bodies.push(request.postDataJSON());
      return route.fulfill({ status: 201, json: { user_id: "judge" } });
    }
    return route.fulfill({ status: 401, contentType: "application/problem+json", json: {} });
  });
  const page = await context.newPage();
  await page.goto(`${site.base}/judge/#invite=${invite}`);
  const start = page.getByRole("button", { name: "Start Judge Mode" });
  await start.waitFor();
  await page.waitForURL(`${site.base}/judge/`);
  await start.click();
  await expect.poll(() => bodies).toEqual([{ invite }]);
  expect(page.url()).not.toContain(invite);
  // The entry before Judge Mode is the blank tab: no history entry kept the invite.
  await page.goBack();
  expect(page.url()).toBe("about:blank");
  await context.close();
});
