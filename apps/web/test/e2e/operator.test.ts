import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { bondPermitTypedData } from "@keelson/chain";
import { type Browser, chromium, devices, type Page, type Route } from "playwright";
import { encodeAbiParameters, type Hex, recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { serveOut } from "./static";
import { installWallet } from "./wallet";

const API = "https://api.keelson.finance";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
/** Operator 351's grade and bond as the API served them. */
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

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

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(AXE_TAGS)
    // AG Grid's trial watermark, and the detail row AG nests in its own row ARIA, are AG's markup.
    .exclude(".ag-watermark")
    .exclude(".ag-row-level-1")
    .analyze();
  return violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

describe.each(Object.keys(VIEWPORTS) as (keyof typeof VIEWPORTS)[])("signed out on %s", (kind) => {
  test("the console asks for the agent owner's wallet and states what is signed", async () => {
    const context = await browser.newContext(VIEWPORTS[kind]);
    await context.route(`${API}/**`, (route) => route.abort("connectionrefused"));
    const page = await context.newPage();
    await page.goto(`${site.base}/operator/`);
    await page.getByRole("heading", { level: 1, name: "Operator console" }).waitFor();
    expect(await page.getByText("EIP-4361").isVisible()).toBe(true);
    await page.getByRole("button", { name: "Sign in with wallet" }).click();
    await page.getByText("No browser wallet found.").waitFor();
    expect(await axe(page)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= screen.width)).toBe(
      true,
    );
    await context.close();
  });
});

const owner = privateKeyToAccount(generatePrivateKey());
const SLASH = {
  id: "01M70ZR8Q4X2A8V9K3YB6T1N5C",
  createdAt: "2026-11-02T14:03:11.000Z",
  merchantId: "mrc_runfast",
  amount: 139,
  premiumBps: 100,
  premium: 1.39,
  state: "SLASHED",
  coverageTx: `https://sepolia.arbiscan.io/tx/0x${"ab".repeat(32)}`,
  disputeId: "PP-D-27803",
  disputeState: "RESOLVED",
  disputeReason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
  disputedAt: "2026-11-03T09:00:00.000Z",
  liable: "operator",
  rule: "R03",
  verdictAmount: 139,
  verdictAt: "2026-11-03T09:00:42.000Z",
  outcome: "paid",
  paidBy: "chain",
  settlementTx: `https://sepolia.arbiscan.io/tx/0x${"cd".repeat(32)}`,
  settledAt: "2026-11-03T09:01:02.000Z",
};
const COVERED = {
  ...SLASH,
  id: "01M70ZR8Q4X2A8V9K3YB6T1N5D",
  state: "SETTLED",
  amount: 42.5,
  premium: 0.425,
  disputeId: null,
  disputeState: null,
  disputeReason: null,
  disputedAt: null,
  liable: null,
  rule: null,
  verdictAmount: null,
  verdictAt: null,
  outcome: null,
  paidBy: null,
  settlementTx: null,
  settledAt: null,
};

/** Answers the API as it answered for operator 351, and records what the console sent. */
async function signedInContext(kind: keyof typeof VIEWPORTS) {
  const context = await browser.newContext(VIEWPORTS[kind]);
  const requests: { path: string; body: unknown }[] = [];
  const { signed } = await installWallet(context, owner, async ({ data }) =>
    // balanceOf and nonces: 5 PYUSD and nonce 0.
    encodeAbiParameters([{ type: "uint256" }], [data.startsWith("0x70a08231") ? 5_000_000n : 0n]),
  );
  let session = false;
  await context.route(`${API}/**`, (route: Route) => {
    const url = new URL(route.request().url());
    const body = route.request().postData();
    requests.push({ path: url.pathname, body: body ? JSON.parse(body) : undefined });
    const json = (value: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    switch (url.pathname) {
      case "/api/auth/siwe/nonce":
        return json({ nonce: "a1b2c3d4e5f6a7b8c9" });
      case "/api/auth/siwe/verify":
        session = true;
        return json({
          token: "t",
          success: true,
          user: { id: "u", walletAddress: owner.address, chainId: 421614 },
        });
      case "/v1/operators/me":
        return session
          ? json({
              wallets: [owner.address],
              operators: [{ agentId: "351", chainId: 421614, name: "Keelson demo operator" }],
            })
          : json({ type: "x/unauthorized", title: "Unauthorized", status: 401 }, 401);
      case "/v1/operators/351/grade":
        return route.fulfill({ contentType: "application/json", body: fixture("grade-351.json") });
      case "/v1/operators/421614/351/bond":
        return route.fulfill({ contentType: "application/json", body: fixture("bond-351.json") });
      case "/v1/operators/351/coverages/daily":
        return json({
          days: [
            { day: "2026-11-02", coverages: 2, covered: 181.5, premiums: 1.815, incidents: 1 },
            { day: "2026-11-03", coverages: 5, covered: 300, premiums: 3, incidents: 0 },
          ],
        });
      case "/v1/operators/351/coverages/rows":
        return json({ rows: [SLASH, COVERED], rowCount: 2 });
      case "/v1/operators/351/grid-query":
        return json({
          gridState: {
            filter: { filterModel: { liable: { filterType: "set", values: ["operator"] } } },
          },
          propertiesToIgnore: ["sort", "columnVisibility"],
          explanation: "Showing only the purchases where the operator was found liable.",
          model: "claude-opus-5-5",
          costMicros: 21_400,
        });
      case "/v1/bonds/351/deposits":
        return json({
          id: "01M70ZTX",
          status: "confirmed",
          hash: `0x${"ef".repeat(32)}`,
          blockNumber: "327900000",
          explorerUrl: `https://sepolia.arbiscan.io/tx/0x${"ef".repeat(32)}`,
        });
      default:
        return route.abort("connectionrefused");
    }
  });
  return { context, requests, signed };
}

test("signed in on a phone: the bond card, the grade's reasons and the book pass axe", async () => {
  const { context } = await signedInContext("mobile");
  const page = await context.newPage();
  await page.goto(`${site.base}/operator/`);
  await page.getByRole("button", { name: "Sign in with wallet" }).click();
  await page.getByRole("heading", { level: 1, name: "Keelson demo operator" }).waitFor();
  await page.getByTestId("grade").waitFor();
  await page.getByTestId("coverage-grid").locator(".ag-row").first().waitFor();
  await page.waitForLoadState("networkidle");
  expect(await page.getByRole("region", { name: "Bond", exact: true }).isVisible()).toBe(true);
  expect(await axe(page)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await context.close();
});

test("signed in: grade, premium and bond; the coverage book with its history; the exact permit, signed", async () => {
  const { context, requests, signed } = await signedInContext("desktop");
  const page = await context.newPage();
  await page.goto(`${site.base}/operator/`);
  await page.getByRole("button", { name: "Sign in with wallet" }).click();
  await page.getByRole("heading", { level: 1, name: "Keelson demo operator" }).waitFor();
  expect(signed[0]?.method).toBe("personal_sign");

  // Grade, premium and coverage, from the API's own answers for operator 351.
  const grade = JSON.parse(fixture("grade-351.json")) as {
    grade: string;
    premium: { bps: number };
  };
  await page.getByTestId("grade").waitFor();
  expect(await page.getByTestId("grade").textContent()).toBe(grade.grade);
  expect(await page.getByTestId("premium").textContent()).toBe(`${grade.premium.bps} bps`);
  expect(await page.getByTestId("bond-ledger").textContent()).toContain("Locked");
  expect(await page.getByTestId("bond-minimum").textContent()).toMatch(/minimum/);

  // The coverage book: SSRM rows, then one row's verdict history in its detail grid.
  const grid = page.getByTestId("coverage-grid");
  await grid.getByText("operator · slash").waitFor();
  await grid.locator(".ag-group-contracted").first().click();
  await page.getByText("Found the operator liable under R03").waitFor();
  expect(await page.getByText("paid by your bond (slash)").isVisible()).toBe(true);

  // A sentence becomes the grid's own filter, sent back to the server-side row model.
  await page.getByLabel("Ask the coverage book").fill("only slashes");
  await page.getByRole("button", { name: "Ask" }).click();
  await page.getByText("Showing only the purchases where the operator was found liable.").waitFor();
  const query = requests.find((r) => r.path.endsWith("/grid-query"))?.body as {
    schema: { type: string };
    gridState: unknown;
  };
  expect(query.schema.type).toBe("object");
  await expect
    .poll(() =>
      requests.some(
        (r) =>
          r.path.endsWith("/coverages/rows") &&
          JSON.stringify((r.body as { filterModel?: unknown }).filterModel).includes("operator"),
      ),
    )
    .toBe(true);

  // The deposit: the amount, the exact permit, then the wallet's signature over it.
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500);
  expect(await axe(page)).toEqual([]);
  await page.getByRole("button", { name: "Top up" }).click();
  await page.getByLabel("Amount").fill("1.25");
  await page.getByText("In your wallet: 5 PYUSD").waitFor();
  await page.getByRole("button", { name: "Review the permit" }).click();
  const permit = await page.getByTestId("permit").textContent();
  expect(permit).toContain("1250000");
  expect(permit).toContain("0xb39898Ef4333f3CB32d1B420E744f5a1Aa2ae2Bf");
  expect(await axe(page)).toEqual([]);
  await page.getByRole("button", { name: /^Sign permit · deposit 1\.25 PYUSD$/ }).click();
  await page.getByTestId("deposit-receipt").waitFor();
  const deposit = requests.find((r) => r.path === "/v1/bonds/351/deposits")?.body as {
    kind: string;
    owner: Hex;
    amount: string;
    deadline: string;
    signature: Hex;
  };
  expect(deposit).toMatchObject({ kind: "permit", owner: owner.address, amount: "1250000" });
  const recovered = await recoverTypedDataAddress({
    ...bondPermitTypedData({
      owner: owner.address,
      value: 1_250_000n,
      nonce: 0n,
      deadline: BigInt(deposit.deadline),
    }),
    signature: deposit.signature,
  });
  expect(recovered).toBe(owner.address);
  await context.close();
});
