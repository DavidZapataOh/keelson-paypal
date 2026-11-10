import { chromium } from "playwright";
import { createPublicClient, type Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { expect, test } from "vitest";
import { installWallet } from "./wallet";

const key = process.env.KEELSON_OPERATOR_KEY as Hex | undefined;
const rpc = process.env.ARBITRUM_SEPOLIA_RPC_URL;
const APP = process.env.KEELSON_APP_ORIGIN ?? "https://app.keelson.finance";
/** PYUSD base units the run deposits; the owner's wallet must hold them. */
const AMOUNT = process.env.KEELSON_LIVE_DEPOSIT ?? "0.5";

// The deployed console with operator 351's owner key as the browser wallet: sign in, read grade,
// premium and coverage, and deposit through a permit Keelson relays on Arbitrum Sepolia.
test.skipIf(!process.env.KEELSON_LIVE || !key || !rpc)(
  "operator 351 deposits gaslessly and sees grade, premium and coverage, live",
  { timeout: 180_000 },
  async () => {
    const chain = createPublicClient({ chain: arbitrumSepolia, transport: http(rpc) });
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await installWallet(context, privateKeyToAccount(key as Hex), async (tx) => {
      const { data } = await chain.call(tx);
      return data ?? "0x";
    });
    const page = await context.newPage();
    await page.goto(`${APP}/operator/`);
    await page.getByRole("button", { name: "Sign in with wallet" }).click();
    await page.getByTestId("grade").waitFor({ timeout: 30_000 });
    const grade = await page.getByTestId("grade").textContent();
    const premium = await page.getByTestId("premium").textContent();
    const ledger = await page.getByTestId("bond-ledger").textContent();
    await page.getByTestId("coverage-grid").locator(".ag-row").first().waitFor({ timeout: 30_000 });
    const coverages = await page.getByText(/^[\d,]+ coverages$/).textContent();
    expect(grade).toMatch(/^[ABCDF]$/);
    expect(premium).toMatch(/^\d+ bps$/);

    await page.getByRole("button", { name: "Deposit PYUSD" }).click();
    await page.getByLabel("Amount").fill(AMOUNT);
    await page.getByRole("button", { name: "Review the permit" }).click();
    await page.getByRole("button", { name: /^Sign permit/ }).click();
    await page.getByTestId("deposit-receipt").waitFor({ timeout: 90_000 });
    const receipt = await page.getByTestId("deposit-receipt").textContent();
    const hash = receipt?.match(/0x[0-9a-f]{64}/)?.[0] as Hex;
    expect((await chain.getTransactionReceipt({ hash })).status).toBe("success");
    console.log(JSON.stringify({ grade, premium, coverages, ledger, deposit: hash }));
    await browser.close();
  },
);
