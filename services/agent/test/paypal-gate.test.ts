import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import { type CheckoutTotal, checkoutTotal, type FxReference, spreadBps } from "@keelson/core";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { StoreBrowser } from "../src/driver.ts";
import { PayGate } from "../src/gate.ts";
import {
  BUYERS,
  type Buyer,
  checkoutDetails,
  convert,
  fundingOptions,
  money,
  reference,
  reviewPage,
  reviewText,
} from "./fixtures/paypal-pages.ts";

const USD_295 = checkoutTotal("USD", { items: 295 });

/** A recorded `GetCheckoutDetails` answer from PayPal's sandbox, with the payee renamed. */
const recorded = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/paypal/${name}.json`, import.meta.url), "utf8"));

/** What the server answers for one order: its review page, its order and its funding options. */
interface Case {
  /** The review page's rows in a locale; English when the page asks for `en_US`. */
  lines: (locale: string) => string[];
  lang: string;
  details?: unknown;
  /** PayPal's conversions of the order for the buyer's funding options, signed in only. */
  funding?: unknown;
  status?: number;
}

const cases = new Map<string, Case>();
let next = 0;
/** Registers a case under a fresh order token. */
const order = (c: Case): string => {
  const token = `0FX${String(++next).padStart(14, "0")}`;
  cases.set(token, c);
  return token;
};

const buyerCase = (buyer: Buyer, o: Partial<Parameters<typeof reviewText>[0]> = {}): Case => ({
  lines: (locale) => reviewText({ buyer, usd: 295, ...o, locale }),
  lang: buyer.locale,
  details: checkoutDetails({ value: "2.95" }),
});

let n = 0;
const call = (name: string, input: Record<string, unknown>): Anthropic.Beta.BetaToolUseBlock =>
  ({
    type: "tool_use",
    id: `toolu_${++n}`,
    name,
    input,
    toolset_name: "browser",
  }) as Anthropic.Beta.BetaToolUseBlock;

const text = (r: Anthropic.Beta.BetaToolResultBlockParam) =>
  (Array.isArray(r.content) ? r.content : [{ type: "text", text: r.content ?? "" }])
    .map((b) => ("text" in b ? b.text : ""))
    .join("\n");

describe("the pay-click gate on PayPal's review page", () => {
  let chrome: Browser;
  let server: Server;
  let origin: string;
  let context: BrowserContext;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "", "http://x");
      if (req.method === "POST" && url.pathname === "/graphql") {
        let body = "";
        req.on("data", (d) => {
          body += d;
        });
        req.on("end", () => {
          const token = String(req.headers["paypal-client-context"] ?? "");
          const c = cases.get(token);
          const funding = body.includes("fundingOptions");
          const answer = funding
            ? (c?.funding ?? { data: { checkoutSession: { fundingOptions: null } } })
            : c?.details;
          res.writeHead(c?.status ?? (answer ? 200 : 404), {
            "content-type": "application/json",
          });
          res.end(JSON.stringify(answer ?? {}));
        });
        return;
      }
      const token = url.searchParams.get("token") ?? "";
      const c = cases.get(token);
      if (!c) {
        res.writeHead(404).end();
        return;
      }
      const english = url.searchParams.get("locale.x") === "en_US";
      const lang = english ? "en" : c.lang;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(reviewPage(c.lines(english ? "en-US" : c.lang), lang));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    chrome = await chromium.launch();
    context = await chrome.newContext();
  });
  afterAll(async () => {
    await chrome?.close();
    await new Promise((r) => server.close(r));
  });

  /** Opens the order's review page with a gate open for `total`, and clicks Pay Now. */
  const pay = async (
    token: string,
    o: {
      total?: CheckoutTotal;
      reference?: FxReference | null;
      maxSpreadBps?: number;
      payee?: string;
      clicks?: number;
      /** The review page's query, `token=…` by default. */
      query?: string;
    } = {},
  ) => {
    const tab: Page = await context.newPage();
    const gate = new PayGate({
      checkoutHosts: ["127.0.0.1"],
      convertHosts: ["127.0.0.1"],
      ...(o.payee ? { payee: o.payee } : {}),
      ...(o.maxSpreadBps !== undefined ? { maxSpreadBps: o.maxSpreadBps } : {}),
    });
    const driver = await StoreBrowser.attach(context, tab, { hosts: ["127.0.0.1"], gate });
    gate.allow(o.total ?? USD_295, o.reference === null ? undefined : (o.reference ?? reference()));
    await driver.toolResult(
      call("navigate", { url: `${origin}/review?${o.query ?? `token=${token}`}` }),
    );
    await tab.waitForLoadState("networkidle");
    const results: string[] = [];
    let error = false;
    for (let i = 0; i < (o.clicks ?? 2); i++) {
      const tree = text(await driver.toolResult(call("read_page", {})));
      const line = tree.split("\n").find((l) => l.includes('button "Pay Now"'));
      const found = /\[(ref_(?:f\d+)?e\d+)\]/.exec(line ?? "")?.[1];
      const r = await driver.toolResult(
        call("left_click", { target: { type: "ref", ref: found } }),
      );
      results.push(text(r));
      error = Boolean(r.is_error);
      if (!error) break;
      await tab.waitForLoadState("networkidle");
    }
    const clicked = (await tab.locator("#out").textContent()) === "clicked Pay Now";
    const url = tab.url();
    await driver.close();
    await tab.close();
    return { gate, clicked, error, results, url };
  };

  describe.each(BUYERS)("a buyer paying in $currency ($locale)", (buyer) => {
    const spread = spreadBps(buyer.rate, reference().rates[buyer.currency] as string);

    test("is paid once the page, read in English, converts the order at its rate", async () => {
      const r = await pay(order(buyerCase(buyer)));
      if (!buyer.locale.startsWith("en")) {
        expect(r.results[0]).toMatch(/switched PayPal's page to English/);
        expect(new URL(r.url).searchParams.get("locale.x")).toBe("en_US");
      }
      expect(r.clicked, r.results.join("\n")).toBe(true);
      expect(r.gate.paid).toEqual({
        charge: {
          intent: "SALE",
          currency: "USD",
          value: "2.95",
          subtotal: "0.00",
          shipping: "0.00",
          tax: "0.00",
          payee: "SANDBOXPAYEE01",
        },
        conversion: expect.objectContaining({
          merchant: { currency: "USD", value: "2.95" },
          buyer: { currency: buyer.currency, value: convert(295, buyer.rate, buyer.shown) },
          rate: buyer.rate,
          spread_bps: spread,
          max_spread_bps: 750,
        }),
      });
    });

    test("is paid at once, in the buyer's own locale, on PayPal's own conversion", async () => {
      const to = convert(295, buyer.rate, buyer.shown);
      const r = await pay(
        order({
          ...buyerCase(buyer),
          funding: fundingOptions({ from: "2.95", to, currency: buyer.currency, rate: buyer.rate }),
        }),
        { clicks: 1 },
      );
      expect(r.clicked, r.results.join("\n")).toBe(true);
      expect(r.gate.paid?.conversion).toMatchObject({
        buyer: { currency: buyer.currency, value: to },
        rate: buyer.rate,
      });
    });

    test("is held for a converted total off PayPal's rate", async () => {
      const wrong = (Number(buyer.rate) * 1.01).toFixed(4);
      const r = await pay(order(buyerCase(buyer, { rate: wrong })));
      expect(r.clicked).toBe(false);
      expect(r.results.at(-1)).toMatch(/not the countersigned one at the page's rate/);
    });

    test("is held with no rate line", async () => {
      const r = await pay(order(buyerCase(buyer, { rate: null })));
      expect(r.clicked).toBe(false);
      expect(r.results.at(-1)).toMatch(/no rate line/);
    });

    test("is held for rates that disagree", async () => {
      const other = (Number(buyer.rate) * 1.02).toFixed(4);
      const r = await pay(
        order(buyerCase(buyer, { extra: [`1 USD = ${other} ${buyer.currency}`] })),
      );
      expect(r.clicked).toBe(false);
      expect(r.results.at(-1)).toMatch(/rates that disagree/);
    });

    test("is held over the mandate's spread", async () => {
      const r = await pay(order(buyerCase(buyer)), { maxSpreadBps: spread - 1 });
      expect(r.clicked).toBe(false);
      expect(r.results.at(-1)).toContain(
        `${spread} basis points from the reference rate of ${reference().rates[buyer.currency]}, over the mandate's cap of ${spread - 1}`,
      );
    });

    test("is held for a larger hidden amount, in either currency", async () => {
      const usd = await pay(order(buyerCase(buyer, { extra: ["Fee $5.00 USD"] })));
      expect(usd.clicked).toBe(false);
      const big = convert(2_950, buyer.rate, buyer.shown);
      const local = await pay(
        order(buyerCase(buyer, { extra: [`Fee ${money(big, buyer.currency, "en-US")}`] })),
      );
      expect(local.clicked).toBe(false);
      expect(local.results.at(-1)).toMatch(/a larger amount in the buyer's currency/);
    });

    test("is held for a total in a third currency", async () => {
      const third = buyer.currency === "EUR" ? "GBP" : "EUR";
      const r = await pay(
        order(buyerCase(buyer, { extra: [`You'll pay ${money("2.75", third, "en-US")}`] })),
      );
      expect(r.clicked).toBe(false);
      expect(r.results.at(-1)).toMatch(/third currency/);
    });
  });

  test("a page that names two orders is held", async () => {
    const [cop] = BUYERS as [Buyer];
    const a = order(buyerCase(cop));
    const b = order(buyerCase(cop, { pays: convert(395, cop.rate, cop.shown) }));
    const r = await pay(a, { query: `token=${a}&token=${b}` });
    expect(r.clicked).toBe(false);
    expect(r.results.at(-1)).toMatch(/could not be read/);
  });

  test("several conversions PayPal states are paid only for the one the page shows, within the cap", async () => {
    const [cop, brl] = BUYERS as [Buyer, Buyer];
    const two = (rates: [string, string]) => ({
      data: {
        checkoutSession: {
          fundingOptions: [
            fundingOptions({
              from: "2.95",
              to: convert(295, rates[0], 0),
              currency: "COP",
              rate: rates[0],
            }).data.checkoutSession.fundingOptions[0],
            fundingOptions({
              from: "2.95",
              to: convert(295, rates[1], 2),
              currency: "BRL",
              rate: rates[1],
            }).data.checkoutSession.fundingOptions[0],
          ],
        },
      },
    });
    const shown = await pay(order({ ...buyerCase(cop), funding: two([cop.rate, brl.rate]) }), {
      clicks: 1,
    });
    expect(shown.clicked, shown.results.join("\n")).toBe(true);
    expect(shown.gate.paid?.conversion?.buyer.currency).toBe("COP");
    // The page shows no rate: which conversion PayPal charges is not known.
    const hidden = await pay(
      order({ ...buyerCase(cop, { rate: null }), funding: two([cop.rate, brl.rate]) }),
      { clicks: 1 },
    );
    expect(hidden.clicked).toBe(false);
    expect(hidden.results[0]).toMatch(/several conversions/);
    // A conversion the buyer could switch to that is over the cap holds too.
    const over = (Number(brl.rate) * 1.2).toFixed(4);
    const r = await pay(order({ ...buyerCase(cop), funding: two([cop.rate, over]) }), {
      clicks: 1,
    });
    expect(r.clicked).toBe(false);
    expect(r.results[0]).toMatch(/over the mandate's cap/);
  });

  test("a new countersign drops the last one's reference rates and payment", async () => {
    const [cop] = BUYERS as [Buyer];
    const r = await pay(order(buyerCase(cop)));
    expect(r.clicked).toBe(true);
    expect(r.gate.paid).toBeDefined();
    r.gate.allow(USD_295);
    expect(r.gate.paid).toBeUndefined();
    const again = await pay(order(buyerCase(cop)), { reference: null });
    expect(again.clicked).toBe(false);
  });

  test("a conversion with no reference rate, or a stale one, is held", async () => {
    const [cop] = BUYERS as [Buyer];
    const none = await pay(order(buyerCase(cop)), { reference: null });
    expect(none.clicked).toBe(false);
    expect(none.results.at(-1)).toMatch(/no current reference rate from USD to COP/);
    const stale = await pay(order(buyerCase(cop)), {
      reference: reference({ as_of: new Date(Date.now() - 49 * 3600_000).toISOString() }),
    });
    expect(stale.clicked).toBe(false);
  });

  test("PayPal's own conversion that the page's rate line contradicts is held", async () => {
    const [cop] = BUYERS as [Buyer];
    const r = await pay(
      order({
        ...buyerCase(cop),
        funding: fundingOptions({ from: "2.95", to: "10329", currency: "COP", rate: "3501.36" }),
      }),
      { clicks: 1 },
    );
    expect(r.clicked).toBe(false);
    expect(r.results[0]).toMatch(/not PayPal's rate/);
  });

  test.each([
    ["another total", checkoutDetails({ value: "3.95" }), /charges USD 3\.95/],
    ["another currency", checkoutDetails({ value: "2.95", currency: "EUR" }), /charges EUR 2\.95/],
    ["no payment", checkoutDetails({ value: "2.95", intent: "ORDER" }), /not a payment/],
    ["no order", { errors: [{ message: "INVALID_RESOURCE_ID" }] }, /could not be read/],
  ])("PayPal's order with %s is held, whatever the page shows", async (_, details, reason) => {
    const r = await pay(
      order({
        lines: () => ["Total $2.95 USD"],
        lang: "en",
        details,
      }),
    );
    expect(r.clicked).toBe(false);
    expect(r.results.at(-1)).toMatch(reason);
  });

  test("PayPal's order for another payee than the mandate names is held", async () => {
    const page = { lines: () => ["Total $2.95 USD"], lang: "en", details: recorded("capture-usd") };
    expect((await pay(order(page), { payee: "SANDBOXPAYEE01" })).clicked).toBe(true);
    const r = await pay(order(page), { payee: "OTHERPAYEE0001" });
    expect(r.clicked).toBe(false);
    expect(r.results.at(-1)).toMatch(/another merchant/);
  });

  test("an unreadable GraphQL answer holds", async () => {
    const r = await pay(
      order({ lines: () => ["Total $2.95 USD"], lang: "en", details: {}, status: 500 }),
    );
    expect(r.clicked).toBe(false);
  });

  test("a recorded sandbox order with its breakdown pays exactly that breakdown", async () => {
    const page = {
      lines: () => ["Total $2.95 USD"],
      lang: "es",
      details: recorded("authorize-usd"),
    };
    const exact = await pay(order(page), {
      total: checkoutTotal("USD", { items: 250, shipping: 27, tax: 18 }),
    });
    expect(exact.clicked, exact.results.join("\n")).toBe(true);
    expect(exact.gate.paid?.charge.intent).toBe("AUTHORIZE");
    // The items alone: PayPal's order adds its own shipping and tax, re-quoted for a countersign.
    const items = await pay(order(page), { total: checkoutTotal("USD", { items: 250 }) });
    expect(items.clicked).toBe(false);
    expect(items.gate.takeRequote()).toEqual(
      checkoutTotal("USD", { items: 250, shipping: 27, tax: 18 }),
    );
    // Another split of the same total is not the countersigned one.
    const split = await pay(order(page), {
      total: checkoutTotal("USD", { items: 250, shipping: 45 }),
    });
    expect(split.clicked).toBe(false);
  });

  test("a recorded zero-decimal order pays its yen", async () => {
    const r = await pay(
      order({ lines: () => ["合計 ¥1,234 JPY"], lang: "ja", details: recorded("capture-jpy") }),
      { total: checkoutTotal("JPY", { items: 1234 }) },
    );
    expect(r.clicked, r.results.join("\n")).toBe(true);
  });
});
