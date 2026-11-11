// Buys a coffee with a single-use card, end to end against the deployed app and API, in test mode:
// a Judge Mode user signs a card mandate with a passkey and holds its budget on PayPal (sandbox
// buyer), the operator's agent builds the cart and is countersigned 2-of-2, Keelson issues the card,
// and Lithic's sandbox plays the card network for a test merchant that does not take PayPal: an
// over-amount charge, a charge at the wrong kind of store, the real charge, a second charge on the
// same card, then the clearing. Prints what each step returned and saves screenshots to SHOTS.
//
// Needs KEELSON_CLIENT_ID, KEELSON_CLIENT_SECRET and KEELSON_AGENT_KEY (the demo operator's client
// and agent key), DEMO_AGENT_ID, JUDGE_INVITE_CODE, KEELSON_EVIDENCE_AGE_RECIPIENT, LITHIC_API_KEY,
// PAYPAL_SANDBOX_BUYER_EMAIL and PAYPAL_SANDBOX_BUYER_PASSWORD.
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { agentKey, apiClient } from "@keelson/agent";
import { decodeAlibi } from "@keelson/alibi";
import { verifyAlibi } from "@keelson/alibi/verify";
import { cartHash } from "@keelson/core";
import { captureEvidence, startRecorder } from "@keelson/evidence/capture";
import { closeMandate } from "@keelson/mandate";
import { approveOrder } from "@keelson/paypal/testing";
import Lithic from "lithic";
import { chromium, type Page } from "playwright";
import { ulid } from "ulid";
import { bytesToHex } from "viem";

const API = process.env.API_ORIGIN ?? "https://api.keelson.finance";
const APP = process.env.APP_ORIGIN ?? "https://app.keelson.finance";
const SHOTS = process.env.SHOTS ?? "card-demo";
const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};

/** The test merchant: a coffee shop on the card networks that takes no PayPal. */
const MERCHANT = {
  descriptor: "HARBOR STREET COFFEE",
  acceptor: "HSC000000000117",
  mcc: "5814",
  city: "SEATTLE",
  state: "WA",
  country: "USA",
};
const PRICE_MINOR = 1450;

mkdirSync(SHOTS, { recursive: true });
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const log = (step: string, value: unknown) =>
  console.log(`${step}: ${typeof value === "string" ? value : JSON.stringify(value)}`);

async function inPage<T>(page: Page, path: string, method = "GET", body?: unknown): Promise<T> {
  return page.evaluate(
    async ({ url, method, body }) => {
      const res = await fetch(url, {
        method,
        credentials: "include",
        headers: {
          ...(method === "POST" ? { "idempotency-key": crypto.randomUUID() } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${text}`);
      return text ? JSON.parse(text) : undefined;
    },
    { url: `${API}${path}`, method, body },
  ) as Promise<T>;
}

/** The user: a Judge Mode tenant signs a card mandate with a passkey and holds it on PayPal. */
async function userSignsAndHolds(): Promise<string> {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "usb",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });
  await page.goto(`${APP}/`);
  await inPage(page, "/v1/judge/sessions", "POST", { invite: env("JUDGE_INVITE_CODE") });
  await page.goto(`${APP}/new/`);
  await page.getByRole("heading", { name: "What may your agent buy?" }).waitFor();
  await page.getByRole("button", { name: "Coffee beans, whole" }).click();
  await page.getByRole("button", { name: "$25", exact: true }).click();
  await page.getByRole("radio", { name: "Any store (PayPal card)" }).check({ force: true });
  await page.getByText("Paid with PayPal · Keelson single-use card.").waitFor();
  await shot(page, "01-builder-card");
  await page.getByRole("button", { name: "Review rules" }).click();
  const create = page.getByRole("button", { name: "Create passkey" });
  const sign = page.getByRole("button", { name: /^Sign · up to/ });
  await Promise.race([create.waitFor({ timeout: 60_000 }), sign.waitFor({ timeout: 60_000 })]);
  if (await create.isVisible()) {
    await create.click();
    await page.getByRole("button", { name: "Passkey ready" }).waitFor({ timeout: 60_000 });
  }
  await sign.waitFor({ timeout: 90_000 });
  await shot(page, "02-review-card-mandate");
  await sign.click();
  await page.getByRole("button", { name: /^Sign: allow up to/ }).waitFor();
  await shot(page, "03-sign-sheet");
  await page.getByRole("button", { name: /^Sign: allow up to/ }).click();
  await page.waitForURL(/\/new\/\?hold=/, { timeout: 90_000 });
  const mid = new URL(page.url()).searchParams.get("hold") as string;
  log("mandate signed", mid);
  await shot(page, "04-hold");
  const { orderId } = await inPage<{ orderId: string }>(page, `/v1/mandates/${mid}/hold`, "POST");
  await approveOrder(
    `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`,
    `${APP}/mandates/${mid}`,
  );
  const held = await inPage<{ state: string }>(page, `/v1/mandates/${mid}/hold/authorize`, "POST", {
    orderId,
  });
  log("budget held on PayPal", held);
  await page.goto(`${APP}/mandate/?id=${mid}`);
  await page.waitForTimeout(2_500);
  await shot(page, "05-mandate-active");
  await browser.close();
  return mid;
}

/** The test merchant's product page, captured by the agent as its evidence. */
async function merchantSite() {
  const product = {
    sku: "hsc-house-blend-12oz",
    title: "House Blend, whole bean, 12 oz",
    price: { currency: "USD", minor: PRICE_MINOR },
  };
  const cart = {
    merchant: "*",
    currency: "USD",
    lines: [{ sku: product.sku, category: "gpt:412", qty: 1, unit_minor: PRICE_MINOR }],
    return_days: 0,
    returns_free: false,
  };
  const server = createServer((req, res) => {
    if (req.url === "/api/product.json") return res.end(JSON.stringify(product));
    if (req.url === "/api/cart.json") return res.end(JSON.stringify(cart));
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><title>Harbor Street Coffee (test merchant)</title>
<body data-ready><h1>Harbor Street Coffee</h1><p>Test merchant: cards only, no PayPal.</p>
<h2>${product.title}</h2><p>$14.50</p><button>Add to cart</button></body>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, product, cart, close: () => server.close() };
}

async function main() {
  const mid = process.env.MANDATE_ID ?? (await userSignsAndHolds());
  const agent = apiClient({
    apiUrl: API,
    clientId: env("KEELSON_CLIENT_ID"),
    clientSecret: env("KEELSON_CLIENT_SECRET"),
    scopes: ["countersign:write", "evidence:write", "mandates:read"],
  });
  const json = async <T>(path: string, init: RequestInit = {}) => {
    const res = await agent.request(path, init);
    const text = await res.text();
    if (!res.ok && res.status !== 202) throw new Error(`${path}: ${res.status} ${text}`);
    return JSON.parse(text) as T;
  };
  const post = <T>(path: string, body: unknown) =>
    json<T>(path, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": ulid() },
      body: JSON.stringify(body),
    });

  // The agent finds the mandate, builds the cart at the test merchant and captures its evidence.
  const { mandates } = await json<{ mandates: { id: string; openMandate: string }[] }>(
    `/v1/operators/${env("DEMO_AGENT_ID")}/mandates`,
  );
  const open = mandates.find((m) => m.id === mid)?.openMandate;
  if (!open) throw new Error(`mandate ${mid} is not active for the operator`);
  const site = await merchantSite();
  const browser = await chromium.launch();
  const page = await (
    await browser.newContext({ viewport: { width: 1280, height: 720 } })
  ).newPage();
  const recorder = await startRecorder(page);
  await page.goto(site.url);
  await page.locator("body[data-ready]").waitFor({ state: "attached" });
  const captured = await captureEvidence(recorder, {
    product: site.product,
    cart: site.cart,
    llmObservation: await page.locator("body").ariaSnapshot(),
    recipient: env("KEELSON_EVIDENCE_AGE_RECIPIENT"),
  });
  await browser.close();
  site.close();
  const evidence = await post<{ root: string }>("/v1/evidence", {
    mandateId: mid,
    manifest: captured.manifest,
    items: captured.items.map((i) => ({
      type: i.type,
      mediaType: i.mediaType,
      salt: Buffer.from(i.salt).toString("base64"),
      bytes: Buffer.from(i.bytes).toString("base64"),
    })),
  });
  log("evidence stored", evidence.root);

  const requestId = ulid();
  const { privateKey } = await agentKey(env("KEELSON_AGENT_KEY"));
  const hash = bytesToHex(cartHash(site.cart)).replace("0x", "");
  const value = (PRICE_MINOR / 100).toFixed(2);
  const started = performance.now();
  const countersigned = await post<{ purchaseId: string; decision: string; mode: string }>(
    "/v1/countersign",
    {
      closedMandate: await closeMandate(
        open,
        { requestId, cartHash: `sha256:${hash}` },
        privateKey,
      ),
      cart: site.cart,
      unit: {
        amount: {
          currency_code: "USD",
          value,
          breakdown: { item_total: { currency_code: "USD", value } },
        },
      },
      evidence: {},
      evidenceRoot: evidence.root,
    },
  );
  log("countersign", { ...countersigned, ms: Math.round(performance.now() - started) });
  const id = countersigned.purchaseId;

  // The card opens once the purchase is logged and covered.
  type View = {
    state: string;
    card?: { state: string; lastFour: string; settledMinor: string | null };
  };
  const until = async (ok: (v: View) => boolean, what: string) => {
    for (let i = 0; i < 120; i++) {
      const v = await json<View>(`/v1/purchases/${id}`);
      if (ok(v)) return v;
      if (v.state === "FAILED") throw new Error(`purchase failed: ${JSON.stringify(v)}`);
      await new Promise((r) => setTimeout(r, 2_000));
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  const opened = await until((v) => v.card?.state === "OPEN", "the card to open");
  log("card open", opened.card);
  const details = await json<{ lastFour: string; embedUrl: string }>(`/v1/purchases/${id}/card`);
  log("card for the agent's browser", {
    lastFour: details.lastFour,
    embed: "issued (not printed)",
  });

  // Charges need the issuer to ask the legs (ASA) and to report settlements (webhooks).
  if (process.env.SKIP_CHARGES) return;

  // Lithic's sandbox plays the card network: it reads the card as a merchant terminal would.
  const lithic = new Lithic({ apiKey: env("LITHIC_API_KEY"), environment: "sandbox" });
  let token: string | undefined;
  for await (const c of lithic.cards.list({ page_size: 100 })) {
    if (c.memo === `Keelson ${id}`) token = c.token;
    if (token) break;
  }
  if (!token) throw new Error("the card is not on the issuer");
  const { pan } = await lithic.cards.retrieve(token);
  if (!pan) throw new Error("the sandbox card has no number");
  const charge = async (label: string, amount: number, mcc = MERCHANT.mcc) => {
    const t0 = performance.now();
    const out = await lithic.transactions.simulateAuthorization({
      amount,
      descriptor: MERCHANT.descriptor,
      pan,
      mcc,
      merchant_acceptor_id: MERCHANT.acceptor,
      merchant_acceptor_city: MERCHANT.city,
      merchant_acceptor_state: MERCHANT.state,
      merchant_acceptor_country: MERCHANT.country,
    });
    const tx = await lithic.transactions.retrieve(out.token as string);
    log(label, { result: tx.result, status: tx.status, ms: Math.round(performance.now() - t0) });
    return tx;
  };
  await charge("over-amount charge", PRICE_MINOR + 500);
  await charge("charge at a restaurant (MCC 5812)", PRICE_MINOR, "5812");
  const paid = await charge("the coffee", PRICE_MINOR);
  await charge("second charge on the same card", 200);
  await lithic.transactions.simulateClearing({ token: paid.token });
  log("clearing", "sent");
  const done = await until((v) => v.state === "CAPTURED", "the capture");
  log("purchase", done);

  const bundle = await fetch(`${API}/v1/alibis/${id}`).then((r) => r.arrayBuffer());
  const report = await verifyAlibi(decodeAlibi(new Uint8Array(bundle)));
  log("alibi", {
    verdict: report.verdict,
    failed: report.checks.filter((c) => c.status === "fail").map((c) => c.id),
    card: report.checks.find((c) => c.id === "card.authorizations"),
  });
  log("receipt", `${APP}/purchase/?mandate=${mid}&id=${id}`);
}

await main();
