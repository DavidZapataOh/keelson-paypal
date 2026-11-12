import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import { type CheckoutTotal, checkoutTotal, type FxReference, spreadBps } from "@keelson/core";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { rateBetween } from "../src/amounts.ts";
import { StoreBrowser } from "../src/driver.ts";
import { PayGate } from "../src/gate.ts";
import {
  BUYERS,
  type Buyer,
  cardForm,
  checkoutDetails,
  convert,
  convertingCard,
  ES_CO_CARD_PAGE,
  ES_CO_CARD_REVIEW,
  fundingSelection,
  HIDDEN_FRAME,
  money,
  payForm,
  payPage,
  plans,
  RECORDED_PAGE,
  RECORDED_SELECTION,
  recorded,
  recordedInstrument,
  reference,
  reviewPage,
  reviewText,
} from "./fixtures/paypal-pages.ts";

const USD_295 = checkoutTotal("USD", { items: 295 });

/** What the server answers for one order: its review page, its order and its funding data. */
interface Case {
  /** The review page's rows. */
  lines: (locale: string) => string[];
  lang: string;
  details?: unknown;
  /** The hosted checkout's `GetFundingOptions` answer; the order paid as it is, by default. */
  plans?: unknown;
  /** On PayPal's `/pay` checkout: the Pay form's fields, and its funding selection. */
  form?: [string, string][];
  selection?: unknown;
  selectionStatus?: number;
  /** `xoos.getCheckoutSummary`'s total; the order's, by default. */
  summary?: { currencyCode: string; value: string };
  /** Runs on the `/pay` page, attributes of its Pay button, and markup after its form. */
  script?: string;
  button?: string;
  after?: string;
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
/** Every page the browser asked for in another language. */
const relocalized: string[] = [];

const orderTotal = (c: Case | undefined) =>
  (
    c?.details as {
      data?: {
        checkoutSession?: {
          cart?: { amounts?: { total?: { currencyValue: string; currencyCode: string } } };
        };
      };
    }
  )?.data?.checkoutSession?.cart?.amounts?.total;

const buyerCase = (buyer: Buyer, o: Partial<Parameters<typeof reviewText>[0]> = {}): Case => {
  const value = convert(295, buyer.rate, buyer.shown);
  return {
    lines: (locale) => reviewText({ buyer, usd: 295, ...o, locale }),
    lang: buyer.locale,
    details: checkoutDetails({ value: "2.95" }),
    plans: plans({
      conversion: {
        buyer: { currencyCode: buyer.currency, currencyValue: value },
        rate: buyer.rate,
      },
    }),
  };
};

/** A Colombian buyer's card PayPal converts USD 2.95 to COP 10,236 on, on `/pay`. */
const copCard = (o: Partial<Case> = {}): Case => ({
  lines: () => [...ES_CO_CARD_REVIEW],
  lang: "es",
  details: checkoutDetails({ value: "2.95" }),
  form: cardForm("COP", "10236"),
  selection: fundingSelection([
    convertingCard({ buyer: "COP", value: "10236", rate: "0.000290145" }),
  ]),
  ...o,
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
      const json = (status: number, answer: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(answer ?? {}));
      };
      if (url.searchParams.has("locale.x")) relocalized.push(url.pathname);
      if (url.pathname.startsWith("/pay/api/trpc/")) {
        const c = cases.get(String(req.headers["x-trpc-token"] ?? ""));
        // PayPal's checkout refuses a call from another origin.
        if (req.headers.origin !== origin) return json(403, { error: "FORBIDDEN" });
        if (url.pathname.endsWith("xoos.getCheckoutSummary")) {
          const total = c?.summary ?? orderTotal(c);
          return json(200, [
            {
              result: {
                data: {
                  json: {
                    __typename: "CheckoutSummarySuccessResponse",
                    payments: {
                      total: total && {
                        currencyCode: total.currencyCode,
                        value: "value" in total ? total.value : total.currencyValue,
                      },
                    },
                  },
                },
              },
            },
          ]);
        }
        return json(c?.selectionStatus ?? 200, c?.selection);
      }
      if (req.method === "POST" && url.pathname === "/graphql") {
        let body = "";
        req.on("data", (d) => {
          body += d;
        });
        req.on("end", () => {
          const c = cases.get(String(req.headers["paypal-client-context"] ?? ""));
          const funding = body.includes("GetFundingOptions");
          const total = orderTotal(c);
          const answer = funding
            ? (c?.plans ??
              plans({
                amount: total ?? { currencyCode: "USD", currencyValue: "2.95" },
              }))
            : c?.details;
          json(c?.status ?? (answer ? 200 : 404), answer);
        });
        return;
      }
      const c = cases.get(url.searchParams.get("token") ?? "");
      if (!c) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        c.form
          ? payPage(c.lines(c.lang), c.lang, c.form, {
              ...(c.script ? { script: c.script } : {}),
              ...(c.button ? { button: c.button } : {}),
              ...(c.after ? { after: c.after } : {}),
            })
          : reviewPage(c.lines(c.lang), c.lang),
      );
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

  /** Opens the order's review page with a gate open for `total`, and clicks its pay button once. */
  const pay = async (
    token: string,
    o: {
      total?: CheckoutTotal;
      reference?: FxReference | null;
      maxSpreadBps?: number;
      payee?: string;
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
    const path = cases.get(token)?.form ? "/pay" : "/review";
    await driver.toolResult(
      call("navigate", { url: `${origin}${path}?${o.query ?? `token=${token}`}` }),
    );
    await tab.waitForLoadState("networkidle");
    const before = relocalized.length;
    const tree = text(await driver.toolResult(call("read_page", {})));
    const line = tree.split("\n").find((l) => /button "Pay( Now)?"/.test(l));
    const found = /\[(ref_(?:f\d+)?e\d+)\]/.exec(line ?? "")?.[1];
    const r = await driver.toolResult(call("left_click", { target: { type: "ref", ref: found } }));
    const out = await tab.locator("#out").textContent();
    const clicked = out === "clicked Pay" || out === "clicked Pay Now";
    const url = tab.url();
    await driver.close();
    await tab.close();
    expect(relocalized.length, "the page is never reloaded in another language").toBe(before);
    return { gate, clicked, error: Boolean(r.is_error), result: text(r), url };
  };

  describe("PayPal's `/pay` checkout", () => {
    test("pays the recorded sandbox order at PayPal's convertedAmount, within the spread of the reference", async () => {
      const ref = reference({ base: "EUR", rates: { USD: "1.10" } });
      const r = await pay(
        order({
          lines: () => RECORDED_PAGE.filter((l) => l !== "Pay"),
          lang: "en",
          details: checkoutDetails({ value: "2.95", currency: "EUR" }),
          form: payForm("pay-form-eur"),
          selection: recorded(RECORDED_SELECTION),
        }),
        { total: checkoutTotal("EUR", { items: 295 }), reference: ref },
      );
      expect(r.clicked, r.result).toBe(true);
      expect(r.gate.paid).toMatchObject({
        charge: { currency: "EUR", value: "2.95" },
        funding: {
          sources: ["xoos.getCheckoutSummary", "xoos.getFundingSelection", "pay-form"],
          instrument: { type: "BANK", lastDigits: "0001" },
          buyer: "USD 3.40",
          rate: "1.152542373",
          quote: "1 USD = 0.866445367 EUR",
        },
        conversion: {
          merchant: { currency: "EUR", value: "2.95" },
          buyer: { currency: "USD", value: "3.40" },
          rate: "1.152542373",
          spread_bps: spreadBps("1.152542373", "1.10"),
        },
      });
    });

    test("pays the recorded card form, whose instrument default names the issuer's conversion", async () => {
      const r = await pay(
        order({
          lines: () => RECORDED_PAGE.filter((l) => l !== "Pay"),
          lang: "en",
          details: checkoutDetails({ value: "2.95", currency: "EUR" }),
          form: payForm("pay-form-eur-card"),
          selection: recorded(RECORDED_SELECTION),
        }),
        {
          total: checkoutTotal("EUR", { items: 295 }),
          reference: reference({ base: "EUR", rates: { USD: "1.10" } }),
        },
      );
      expect(r.clicked, r.result).toBe(true);
      expect(r.gate.paid?.funding.instrument).toEqual({ type: "CARD", lastDigits: "4242" });
    });

    test("pays a Colombian card at COP 10,236, 67 basis points over PayPal's own rate", async () => {
      const r = await pay(order(copCard()));
      expect(r.clicked, r.result).toBe(true);
      expect(r.gate.refused).toBe(0);
      expect(r.gate.paid?.funding).toEqual({
        sources: ["xoos.getCheckoutSummary", "xoos.getFundingSelection", "pay-form"],
        instrument: { type: "CARD", lastDigits: "4242" },
        buyer: "COP 10236",
        rate: "3469.830508",
        quote: "1 COP = 0.000290145 USD",
      });
      expect(r.gate.paid?.conversion).toMatchObject({
        buyer: { currency: "COP", value: "10236" },
        rate: "3469.830508",
        spread_bps: spreadBps("3469.830508", reference().rates.COP as string),
      });
    });

    test("an instrument the buyer does not pay with does not hold, however it converts", async () => {
      const bank = { ...convertingCard({ buyer: "COP", value: "99999", rate: "0.0001" }) };
      bank.id = "BA-SANDBOXBANK0001";
      bank.type = "BANK";
      const card = convertingCard({ buyer: "COP", value: "10236", rate: "0.000290145" });
      const r = await pay(order(copCard({ selection: fundingSelection([bank, card]) })));
      expect(r.clicked, r.result).toBe(true);
    });

    test.each<[string, Partial<Case>, RegExp]>([
      [
        "an instrument PayPal's funding data does not hold",
        { form: cardForm("COP", "10236", { fundingInstrumentId: "CC-SOMEONEELSE001" }) },
        /does not hold the instrument the pay form pays with/,
      ],
      [
        "an amount in the form that is not PayPal's convertedAmount",
        { form: cardForm("COP", "10200") },
        /pays another conversion than its funding data states/,
      ],
      [
        "no conversion option named while PayPal converts",
        { form: cardForm("COP", "10236", { selectedCurrencyConversionOptionType: null }) },
        /names no conversion option/,
      ],
      [
        "the card issuer's conversion",
        {
          form: cardForm("COP", "10236", {
            selectedCurrencyConversionOptionType: "VENDOR",
            selectedRadioFiConvertedAmount: null,
          }),
        },
        /issuer would convert the charge/,
      ],
      [
        "a split with the PayPal balance",
        { form: cardForm("COP", "10236", { balanceInstrumentCount: "1", useBalance: "on" }) },
        /splits the payment/,
      ],
      [
        "a purchase amount that is not the order's",
        { form: cardForm("COP", "10236", { purchaseAmount: "3.95" }) },
        /pays another amount than its order/,
      ],
      [
        "a checkout summary that is not the order",
        { summary: { currencyCode: "USD", value: "3.95" } },
        /checkout summary does not state its order's total/,
      ],
      [
        "a funding selection PayPal refuses (401)",
        { selectionStatus: 401, selection: [{ error: { json: { message: "NOT_AUTHORIZED" } } }] },
        /funding data could not be read/,
      ],
      [
        "a funding selection answered as an error",
        {
          selection: [
            { result: { data: { json: { __typename: "FundingSelectionErrorResponse" } } } },
          ],
        },
        /funding data could not be read/,
      ],
      [
        "an instrument PayPal does not allow",
        {
          selection: fundingSelection([
            {
              ...convertingCard({ buyer: "COP", value: "10236", rate: "0.000290145" }),
              usability: { __typename: "FundingDisallowed", status: "DISALLOWED" },
            },
          ]),
        },
        /not usable/,
      ],
      [
        "a Pay form PayPal's client is still updating",
        {
          script:
            "let i = 0; setInterval(() => { document.querySelector('[name=selectedRadioFiConvertedAmount]').value = String(10236 + ++i); }, 40);",
        },
        /still updating/,
      ],
      ["a busy Pay button", { button: ' aria-busy="true"' }, /still updating/],
      [
        "a larger peso amount on the page",
        { lines: () => [...ES_CO_CARD_REVIEW, "Comisión $ 30.000"] },
        /a larger amount in the buyer's currency/,
      ],
      [
        "a converted total on the page that is not PayPal's",
        { lines: () => [...ES_CO_CARD_REVIEW, "Pagarás $ 10.300 COP"] },
        /converted total that is not PayPal's conversion|larger amount in the buyer's currency/,
      ],
      [
        "a rate line that is not PayPal's rate rounded",
        { lines: () => ES_CO_CARD_REVIEW.map((l) => l.replace("0,00029", "0,00031")) },
        /rate line that is not PayPal's rate/,
      ],
    ])("holds for %s", async (_, o, reason) => {
      const r = await pay(order(copCard(o)));
      expect(r.clicked).toBe(false);
      expect(r.result).toMatch(reason);
      expect(r.gate.paid).toBeUndefined();
    });

    test("a rate PayPal writes as a JSON number is not taken as its rate, so its rate line holds", async () => {
      const card = convertingCard({ buyer: "COP", value: "10236", rate: "0.000290145" });
      const [option] = card.currencyConversionOptions as [
        { conversionRate: Record<string, unknown> },
      ];
      option.conversionRate.toAmount = 0.000290145;
      const r = await pay(order(copCard({ selection: fundingSelection([card]) })));
      expect(r.clicked).toBe(false);
      expect(r.result).toMatch(/rate line that is not PayPal's rate/);
      expect(r.gate.held.at(-1)?.paypal).toMatchObject({ buyer: "COP 10236" });
      expect(r.gate.held.at(-1)?.paypal?.quote).toBeUndefined();
    });

    test("holds over the mandate's spread of the reference, and logs the charge, its rate and PayPal's", async () => {
      const r = await pay(order(copCard()), { maxSpreadBps: 100 });
      expect(r.clicked).toBe(false);
      expect(r.result).toMatch(
        /PayPal charges 10236 COP, 3469\.830508 COP per USD, \d+ basis points from the reference rate of [\d.]+, over the mandate's cap of 100/,
      );
      expect(r.gate.held.at(-1)?.paypal).toEqual({
        sources: ["xoos.getCheckoutSummary", "xoos.getFundingSelection", "pay-form"],
        instrument: { type: "CARD", lastDigits: "4242" },
        buyer: "COP 10236",
        rate: "3469.830508",
        quote: "1 COP = 0.000290145 USD",
      });
    });

    test("a page on `/pay` whose Pay form names no instrument holds", async () => {
      const r = await pay(order(copCard({ form: [["purchaseAmount", "2.95"]] })));
      expect(r.clicked).toBe(false);
      expect(r.result).toMatch(/names no funding instrument/);
    });

    test("a bank account with no conversion pays the order as it is", async () => {
      const bank = recordedInstrument("BANK");
      bank.currencyConversionOptions = [];
      const r = await pay(
        order({
          lines: () => ["Total $2.95 USD"],
          lang: "en",
          details: checkoutDetails({ value: "2.95" }),
          form: payForm("pay-form-eur", {
            purchaseCurrencyCode: "USD",
            selectedCurrencyConversionOptionType: null,
            selectedCurrencyConversionOptionCode: null,
            selectedRadioFiConvertedAmount: null,
            selectedRadioFiCurrencyConversionType: null,
            selectedRadioFiCurrencyConversionCurrencyCode: null,
            selectedRadioFiCurrencyConversionConvertedAmount: null,
          }),
          selection: fundingSelection([bank]),
        }),
      );
      expect(r.clicked, r.result).toBe(true);
      expect(r.gate.paid?.conversion).toBeUndefined();
      expect(r.gate.paid?.funding.buyer).toBe("USD 2.95");
    });
  });

  describe("a Colombian card on `/pay`, as the gate logged its page", () => {
    /** PayPal's charge of COP 10,236, shown as 1 COP = 0.000288197 USD. */
    const page = (o: Partial<Case> = {}) =>
      copCard({
        lines: () => [...ES_CO_CARD_PAGE],
        selection: fundingSelection([
          convertingCard({ buyer: "COP", value: "10236", rate: "0.000288197" }),
        ]),
        after: HIDDEN_FRAME,
        ...o,
      });

    test("pays: the bare `$ 10.236` is PayPal's peso charge, and frames PayPal never shows are not read", async () => {
      const r = await pay(order(page()));
      expect(r.clicked, r.result).toBe(true);
      expect(r.gate.paid?.funding).toMatchObject({
        buyer: "COP 10236",
        quote: "1 COP = 0.000288197 USD",
      });
    });

    test("a number with no mark that is exactly PayPal's charge is that charge", async () => {
      const r = await pay(order(page({ lines: () => [...ES_CO_CARD_PAGE, "Total 10.236"] })));
      expect(r.clicked, r.result).toBe(true);
    });

    test.each<[string, string, RegExp]>([
      ["another bare peso amount", "Comisión $ 10.300", /a larger amount in the buyer's currency/],
      ["another number with no mark", "Total 10.300", /a larger amount that may be charged/],
      [
        "a rate line that is not PayPal's rate rounded",
        "1 COP = 0,00031 USD",
        /rate line that is not PayPal's rate|rates that disagree/,
      ],
    ])("holds for %s, and logs every number that may be dollars", async (_, line, reason) => {
      const r = await pay(order(page({ lines: () => [...ES_CO_CARD_PAGE, line] })));
      expect(r.clicked).toBe(false);
      expect(r.result).toMatch(reason);
      expect(r.gate.held.at(-1)?.loose).toBeDefined();
    });
  });

  describe.each(BUYERS)(
    "PayPal's hosted checkout for a buyer paying in $currency ($locale)",
    (buyer) => {
      const value = convert(295, buyer.rate, buyer.shown);
      const rate = rateBetween("2.95", value);
      const spread = spreadBps(rate, reference().rates[buyer.currency] as string);

      test("is paid at once, in the buyer's own locale, on PayPal's own conversion", async () => {
        const r = await pay(order(buyerCase(buyer)));
        expect(r.clicked, r.result).toBe(true);
        expect(new URL(r.url).searchParams.get("locale.x")).toBeNull();
        expect(r.gate.paid).toEqual({
          charge: {
            intent: "SALE",
            currency: "USD",
            value: "2.95",
            subtotal: "0.00",
            shipping: "0.00",
            tax: "0.00",
            discount: "0.00",
            payee: "SANDBOXPAYEE01",
          },
          funding: {
            sources: ["GetFundingOptions.allPlans"],
            instrument: { type: "CARD", lastDigits: "4242" },
            buyer: `${buyer.currency} ${value}`,
            rate,
            quote: `1 USD = ${buyer.rate} ${buyer.currency}`,
          },
          conversion: expect.objectContaining({
            merchant: { currency: "USD", value: "2.95" },
            buyer: { currency: buyer.currency, value },
            rate,
            spread_bps: spread,
            max_spread_bps: 750,
          }),
        });
      });

      test("is paid with no rate line on the page", async () => {
        const r = await pay(order(buyerCase(buyer, { rate: null })));
        expect(r.clicked, r.result).toBe(true);
      });

      test("is held for a page rate line that is not PayPal's rate", async () => {
        const wrong = (Number(buyer.rate) * 1.01).toFixed(4);
        const r = await pay(order(buyerCase(buyer, { rate: wrong })));
        expect(r.clicked).toBe(false);
        expect(r.result).toMatch(/rate line that is not PayPal's rate|not PayPal's conversion/);
      });

      test("is held for rates that disagree", async () => {
        const other = (Number(buyer.rate) * 1.02).toFixed(4);
        const r = await pay(
          order(buyerCase(buyer, { extra: [`1 USD = ${other} ${buyer.currency}`] })),
        );
        expect(r.clicked).toBe(false);
        expect(r.result).toMatch(/rates that disagree/);
      });

      test("is held over the mandate's spread", async () => {
        const r = await pay(order(buyerCase(buyer)), { maxSpreadBps: spread - 1 });
        expect(r.clicked).toBe(false);
        expect(r.result).toContain(
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
        expect(local.result).toMatch(/a larger amount in the buyer's currency|not read whole/);
      });

      test("is held for a total in a third currency", async () => {
        const third = buyer.currency === "EUR" ? "GBP" : "EUR";
        const r = await pay(
          order(buyerCase(buyer, { extra: [`You'll pay ${money("2.75", third, "en-US")}`] })),
        );
        expect(r.clicked).toBe(false);
        expect(r.result).toMatch(/third currency/);
      });

      test("is held when only the page's text converts the order", async () => {
        const r = await pay(order({ ...buyerCase(buyer), plans: plans() }));
        expect(r.clicked).toBe(false);
        expect(r.result).toMatch(/a conversion PayPal's funding data does not state/);
      });
    },
  );

  describe("the hosted checkout's selected plan", () => {
    const cop = BUYERS[0] as Buyer;
    const value = convert(295, cop.rate, cop.shown);
    const conversion = { buyer: { currencyCode: "COP", currencyValue: value }, rate: cop.rate };

    test("is the one paid: another plan's worse rate does not hold", async () => {
      const worse = plans({
        conversion: { ...conversion, buyer: { currencyCode: "COP", currencyValue: "99999" } },
      }).data.checkoutSession.fundingOptions[0]?.allPlans[0] as Record<string, unknown>;
      const r = await pay(
        order({
          ...buyerCase(cop),
          plans: plans({ conversion, others: [{ ...worse, isSelected: false }] }),
        }),
      );
      expect(r.clicked, r.result).toBe(true);
    });

    test.each<[string, unknown, RegExp]>([
      [
        "GraphQL errors",
        { errors: [{ message: "auth state ANONYMOUS" }], data: { checkoutSession: null } },
        /funding data could not be read/,
      ],
      ["a split between two sources", plans({ conversion, sources: 2 }), /splits the payment/],
      [
        "the issuer's conversion",
        plans({ conversion: { ...conversion, type: "VENDOR" } }),
        /issuer/,
      ],
      [
        "a funding amount that is not the order",
        plans({ amount: { currencyCode: "USD", currencyValue: "3.95" } }),
        /pays another amount than its order/,
      ],
    ])("holds for %s, with nothing read from the page", async (_, answer, reason) => {
      const r = await pay(order({ ...buyerCase(cop), plans: answer }));
      expect(r.clicked).toBe(false);
      expect(r.result).toMatch(reason);
    });
  });

  test("a page that names two orders is held", async () => {
    const [cop] = BUYERS as [Buyer];
    const a = order(buyerCase(cop));
    const b = order(buyerCase(cop, { pays: convert(395, cop.rate, cop.shown) }));
    const r = await pay(a, { query: `token=${a}&token=${b}` });
    expect(r.clicked).toBe(false);
    expect(r.result).toMatch(/could not be read/);
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
    expect(none.result).toMatch(/no current reference rate from USD to COP/);
    const stale = await pay(order(buyerCase(cop)), {
      reference: reference({ as_of: new Date(Date.now() - 49 * 3600_000).toISOString() }),
    });
    expect(stale.clicked).toBe(false);
  });

  test.each([
    ["another total", checkoutDetails({ value: "3.95" }), /charges USD 3\.95/],
    ["another currency", checkoutDetails({ value: "2.95", currency: "EUR" }), /charges EUR 2\.95/],
    ["no payment", checkoutDetails({ value: "2.95", intent: "ORDER" }), /not a payment/],
    ["no order", { errors: [{ message: "INVALID_RESOURCE_ID" }] }, /could not be read/],
  ])("PayPal's order with %s is held, whatever the page shows", async (_, details, reason) => {
    const r = await pay(order({ lines: () => ["Total $2.95 USD"], lang: "en", details }));
    expect(r.clicked).toBe(false);
    expect(r.result).toMatch(reason);
  });

  test("PayPal's order for another payee than the mandate names is held", async () => {
    const page = { lines: () => ["Total $2.95 USD"], lang: "en", details: recorded("capture-usd") };
    expect((await pay(order(page), { payee: "SANDBOXPAYEE01" })).clicked).toBe(true);
    const r = await pay(order(page), { payee: "OTHERPAYEE0001" });
    expect(r.clicked).toBe(false);
    expect(r.result).toMatch(/another merchant/);
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
    expect(exact.clicked, exact.result).toBe(true);
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

  test("an order with insurance, duties and a discount is re-quoted with all of them", async () => {
    // As PayPal's sandbox answers: shipping and handling net of the shipping discount; insurance,
    // duties and the discount apart.
    const details = checkoutDetails({
      value: "2.85",
      parts: {
        subtotal: "2.50",
        shipping: "0.20",
        insurance: "0.10",
        tax: "0.10",
        smartDuty: "0.05",
        discount: "0.10",
      },
    });
    const page = {
      lines: () => ["Total $2.85 USD"],
      lang: "en",
      details,
      plans: plans({ amount: { currencyCode: "USD", currencyValue: "2.85" } }),
    };
    const quoted = checkoutTotal("USD", { items: 250, discount: 10 });
    const r = await pay(order(page), { total: quoted });
    expect(r.clicked).toBe(false);
    const next = r.gate.takeRequote();
    expect(next).toEqual(checkoutTotal("USD", { items: 250, shipping: 30, tax: 15, discount: 10 }));
    const paid = await pay(order(page), { total: next as CheckoutTotal });
    expect(paid.clicked, paid.result).toBe(true);
  });

  test("a recorded zero-decimal order pays its yen", async () => {
    const r = await pay(
      order({
        lines: () => ["合計 ¥1,234 JPY"],
        lang: "ja",
        details: recorded("capture-jpy"),
        plans: plans({ amount: { currencyCode: "JPY", currencyValue: "1234" } }),
      }),
      { total: checkoutTotal("JPY", { items: 1234 }) },
    );
    expect(r.clicked, r.result).toBe(true);
  });
});
