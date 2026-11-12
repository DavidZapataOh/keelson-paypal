import { decimalParts } from "@keelson/core";
import type { Locator, Page } from "playwright";
import type { Quote } from "./amounts.ts";
import type { PayPalCharge } from "./paypal-order.ts";

/**
 * The fields of PayPal's Pay form that say what the click pays with: the funding instrument, its
 * share of the order, any split with balance, rewards or incentives, the conversion option and the
 * buyer's amount, and the purchase itself. Their values are what PayPal's page submits.
 */
const FIELDS = new Set([
  "fundingInstrumentId",
  "fundingInstrumentType",
  "fundingInstrumentAmount",
  "useBalance",
  "balanceInstrumentId",
  "balanceInstrumentAmount",
  "balanceInstrumentCount",
  "issuerRewardId",
  "issuerRewardAmount",
  "payPalRewardsInstrumentAmount",
  "incentivesCount",
  "selectedCurrencyConversionOptionType",
  "selectedCurrencyConversionOptionCode",
  "selectedRadioFiConvertedAmount",
  "selectedRadioFiCurrencyConversionType",
  "selectedRadioFiCurrencyConversionCurrencyCode",
  "selectedRadioFiCurrencyConversionConvertedAmount",
  "purchaseAmount",
  "purchaseCurrencyCode",
]);

/** The Pay form's fields, by name. */
export type PayForm = Record<string, string>;

/**
 * The fields of {@link FIELDS} in the form the pay control at `target` submits, or undefined when
 * it submits none.
 */
export async function readPayForm(target: Locator): Promise<PayForm | undefined> {
  const fields = await target
    .evaluate((node) => {
      const el = node.closest("button, input, [role=button]") ?? node;
      const form =
        (el instanceof HTMLButtonElement || el instanceof HTMLInputElement ? el.form : null) ??
        el.closest("form");
      if (!form) return null;
      return [...new FormData(form).entries()].map(([k, v]) => [k, String(v)] as const);
    })
    .catch(() => null);
  if (!fields) return undefined;
  return Object.fromEntries(
    fields.filter(([k]) => FIELDS.has(k) || /^incentiveAmount\d+$/.test(k)),
  );
}

const VALUE = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const ISO = /^[A-Z]{3}$/;

/** Whether two decimal strings are the same number: `3.4` and `3.40`. */
function same(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string" || !VALUE.test(a) || !VALUE.test(b)) {
    return false;
  }
  const x = decimalParts(a);
  const y = decimalParts(b);
  const scale = Math.max(x.scale, y.scale);
  return x.int * 10n ** BigInt(scale - x.scale) === y.int * 10n ** BigInt(scale - y.scale);
}

const isZero = (v: string | undefined) => v === undefined || v === "" || same(v, "0");

/** What PayPal charges the buyer for the order, from PayPal's own data for the selected funding. */
export interface Funding {
  /** The PayPal sources it was read from. */
  sources: string[];
  instrument: { type: string; lastDigits?: string };
  /** The amount PayPal charges the buyer: the order's total, or PayPal's conversion of it. */
  buyer: { currency: string; value: string };
  /** The rate PayPal shows for its conversion, per unit, when it converts. */
  quote?: Quote;
}

type FundingRead =
  | { ok: true; funding: Funding }
  | { ok: false; reason: string; funding?: Partial<Funding> };

type Amount = { currencyCode?: unknown; value?: unknown; currencyValue?: unknown };

/** An amount PayPal writes as `{ value | currencyValue, currencyCode }`, or undefined. */
function amountOf(a: Amount | null | undefined): { currency: string; value: string } | undefined {
  const value = a?.value ?? a?.currencyValue;
  const currency = a?.currencyCode;
  return typeof value === "string" &&
    VALUE.test(value) &&
    typeof currency === "string" &&
    ISO.test(currency)
    ? { currency, value }
    : undefined;
}

/**
 * PayPal's rate per unit between the buyer's currency and the order's, as `1 COP = 0.000290145
 * USD` or `1 USD = 3446.55 COP`; undefined unless it is between those two currencies, from 1 unit.
 */
function quoteOf(
  from: { currency: string; value: string } | undefined,
  to: { currency: string; value: string } | undefined,
  buyer: string,
  order: string,
): Quote | undefined {
  if (!from || !to || !same(from.value, "1") || same(to.value, "0")) return undefined;
  if (from.currency === buyer && to.currency === order) {
    return { currency: buyer, rate: to.value, inverse: true };
  }
  if (from.currency === order && to.currency === buyer) {
    return { currency: buyer, rate: to.value, inverse: false };
  }
  return undefined;
}

/**
 * What the Pay form will pay with, from the `xoos.getFundingSelection` answer of PayPal's `/pay`
 * checkout and the form's fields. The form names the instrument and the conversion option; PayPal's
 * funding selection must hold that instrument, usable, and that option, whose `convertedAmount` is
 * the form's amount. A split with balance, rewards or incentives, an option the card's issuer
 * converts (`VENDOR`), or anything not read whole, is not paid.
 *
 * The form writes the option twice: `selectedCurrencyConversionOption*`, the option the page shows
 * and charges, and `selectedRadioFiCurrencyConversion*`, the instrument's own default, which may
 * name `VENDOR` while the buyer pays PayPal's conversion. The first decides; the second, when it
 * names PayPal's conversion, must agree with it.
 */
function fundingFromSelection(answer: unknown, form: PayForm, charge: PayPalCharge): FundingRead {
  const no = (reason: string, funding?: Partial<Funding>): FundingRead => ({
    ok: false,
    reason,
    ...(funding ? { funding } : {}),
  });
  const sources = ["xoos.getFundingSelection", "pay-form"];
  if (form.purchaseCurrencyCode !== charge.currency || !same(form.purchaseAmount, charge.value)) {
    return no("PayPal's pay form pays another amount than its order");
  }
  if (
    !isZero(form.balanceInstrumentCount) ||
    form.useBalance !== undefined ||
    form.balanceInstrumentId !== undefined ||
    !isZero(form.balanceInstrumentAmount) ||
    !isZero(form.issuerRewardAmount) ||
    !isZero(form.payPalRewardsInstrumentAmount) ||
    !isZero(form.incentivesCount) ||
    Object.keys(form).some((k) => /^incentiveAmount\d+$/.test(k)) ||
    !same(form.fundingInstrumentAmount, charge.value)
  ) {
    return no("PayPal's pay form splits the payment between funding sources");
  }
  const selection = (answer as [{ result?: { data?: { json?: unknown } } }] | null)?.[0]?.result
    ?.data?.json as
    | {
        __typename?: unknown;
        fundingInstruments?: {
          id?: unknown;
          type?: unknown;
          lastDigits?: unknown;
          currency?: unknown;
          usability?: { status?: unknown };
          currencyConversionOptions?: {
            type?: unknown;
            convertedAmount?: Amount;
            conversionRate?: {
              fromAmount?: unknown;
              fromCurrency?: unknown;
              toAmount?: unknown;
              toCurrency?: unknown;
            };
          }[];
        }[];
      }
    | undefined;
  if (
    selection?.__typename !== "FundingSelectionSuccessResponse" ||
    !Array.isArray(selection.fundingInstruments)
  ) {
    return no("PayPal's funding data could not be read");
  }
  const found = selection.fundingInstruments.filter((i) => i?.id === form.fundingInstrumentId);
  const inst = found[0];
  if (found.length !== 1 || !inst || typeof inst.type !== "string") {
    return no("PayPal's funding data does not hold the instrument the pay form pays with");
  }
  const instrument = {
    type: inst.type,
    ...(typeof inst.lastDigits === "string" ? { lastDigits: inst.lastDigits } : {}),
  };
  if (inst.usability?.status !== "USABLE") {
    return no("the instrument the pay form pays with is not usable", { sources, instrument });
  }
  const options = inst.currencyConversionOptions ?? [];
  if (!Array.isArray(options)) return no("PayPal's funding data could not be read");
  const type = form.selectedCurrencyConversionOptionType;
  if (options.length === 0) {
    if (type !== undefined || (inst.currency !== undefined && inst.currency !== charge.currency)) {
      return no("PayPal's pay form names a conversion its funding data does not hold", {
        sources,
        instrument,
      });
    }
    return {
      ok: true,
      funding: {
        sources,
        instrument,
        buyer: { currency: charge.currency, value: charge.value },
      },
    };
  }
  if (type === undefined) {
    return no("PayPal converts, and the pay form names no conversion option", {
      sources,
      instrument,
    });
  }
  const matching = options.filter((o) => o?.type === type);
  const option = matching[0];
  if (matching.length !== 1 || !option) {
    return no("PayPal's funding data does not hold the conversion option the pay form names", {
      sources,
      instrument,
    });
  }
  if (type !== "PAYPAL") {
    return no("the card's issuer would convert the charge, at a rate PayPal does not state", {
      sources,
      instrument,
    });
  }
  const buyer = amountOf(option.convertedAmount);
  if (
    !buyer ||
    buyer.currency === charge.currency ||
    form.selectedCurrencyConversionOptionCode !== buyer.currency ||
    !same(form.selectedRadioFiConvertedAmount, buyer.value)
  ) {
    return no("PayPal's pay form pays another conversion than its funding data states", {
      sources,
      instrument,
    });
  }
  if (
    form.selectedRadioFiCurrencyConversionType === "PAYPAL" &&
    (form.selectedRadioFiCurrencyConversionCurrencyCode !== buyer.currency ||
      !same(form.selectedRadioFiCurrencyConversionConvertedAmount, buyer.value))
  ) {
    return no("PayPal's pay form names two conversions", { sources, instrument, buyer });
  }
  const r = option.conversionRate;
  const quote = quoteOf(
    amountOf({ value: r?.fromAmount, currencyCode: r?.fromCurrency }),
    amountOf({ value: r?.toAmount, currencyCode: r?.toCurrency }),
    buyer.currency,
    charge.currency,
  );
  return { ok: true, funding: { sources, instrument, buyer, ...(quote ? { quote } : {}) } };
}

/**
 * The funding query PayPal's hosted checkout (`/graphql`) selects for the plan the buyer pays
 * with (`threeDsContingencyQuery` in its `weasley` client), trimmed to the money fields.
 */
const LEGACY_FUNDING =
  "query GetFundingOptions($orderID: String!) { checkoutSession(token: $orderID) { fundingOptions(returnAllPlans: true, groupSourcesOnType: INCENTIVE) { allPlans { isSelected fundingSources { fundingInstrument { id type lastDigits } amount { currencyCode currencyValue } } currencyConversion { type from { currencyCode currencyValue } to { currencyCode currencyValue } convertedAmount { currencyCode currencyValue } } } } } }";

/**
 * What the selected plan of PayPal's hosted checkout pays with: one funding source, whose amount
 * is the order's total or PayPal's `convertedAmount` of it. Errors, no plan or several selected,
 * a split, or an option the card's issuer converts, are not paid.
 */
function fundingFromPlans(answer: unknown, charge: PayPalCharge): FundingRead {
  const no = (reason: string, funding?: Partial<Funding>): FundingRead => ({
    ok: false,
    reason,
    ...(funding ? { funding } : {}),
  });
  const sources = ["GetFundingOptions.allPlans"];
  type Plan = {
    isSelected?: unknown;
    fundingSources?: {
      fundingInstrument?: { type?: unknown; lastDigits?: unknown };
      amount?: Amount;
    }[];
    currencyConversion?: {
      type?: unknown;
      from?: Amount;
      to?: Amount;
      convertedAmount?: Amount;
    } | null;
  };
  const a = answer as {
    errors?: unknown;
    data?: { checkoutSession?: { fundingOptions?: { allPlans?: Plan[] }[] } };
  } | null;
  const options = a?.data?.checkoutSession?.fundingOptions;
  if (!a || a.errors !== undefined || !Array.isArray(options)) {
    return no("PayPal's funding data could not be read");
  }
  const selected = options.flatMap((o) => (Array.isArray(o?.allPlans) ? o.allPlans : []));
  const plans = selected.filter((p) => p?.isSelected === true);
  const plan = plans[0];
  if (plans.length !== 1 || !plan) return no("PayPal's funding data names no one selected plan");
  const [src, ...more] = Array.isArray(plan.fundingSources) ? plan.fundingSources : [];
  const amount = amountOf(src?.amount);
  if (!src || more.length > 0 || !amount || typeof src.fundingInstrument?.type !== "string") {
    return no("PayPal's selected plan splits the payment between funding sources");
  }
  const instrument = {
    type: src.fundingInstrument.type,
    ...(typeof src.fundingInstrument.lastDigits === "string"
      ? { lastDigits: src.fundingInstrument.lastDigits }
      : {}),
  };
  const cc = plan.currencyConversion;
  if (!cc) {
    if (amount.currency !== charge.currency || !same(amount.value, charge.value)) {
      return no("PayPal's selected plan pays another amount than its order", {
        sources,
        instrument,
      });
    }
    return { ok: true, funding: { sources, instrument, buyer: amount } };
  }
  if (cc.type !== "PAYPAL") {
    return no("the card's issuer would convert the charge, at a rate PayPal does not state", {
      sources,
      instrument,
    });
  }
  const buyer = amountOf(cc.convertedAmount);
  if (
    !buyer ||
    buyer.currency === charge.currency ||
    buyer.currency !== amount.currency ||
    !same(buyer.value, amount.value)
  ) {
    return no("PayPal's selected plan pays another amount than its conversion", {
      sources,
      instrument,
    });
  }
  const quote = quoteOf(amountOf(cc.from), amountOf(cc.to), buyer.currency, charge.currency);
  return { ok: true, funding: { sources, instrument, buyer, ...(quote ? { quote } : {}) } };
}

/**
 * What PayPal will charge the buyer for the order the PayPal page in `page` is for, when its Pay
 * form (`form`) is submitted: on PayPal's `/pay` checkout, from `xoos.getFundingSelection` and
 * the form; on its hosted checkout, from the selected plan. PayPal's `/pay` checkout must also
 * state the order's total in `xoos.getCheckoutSummary`. The requests go to the page's origin with
 * the session's cookies, outside the page, so no script on it can answer them. Any error, refusal
 * or answer not read whole is not paid; nothing falls back to the page's text.
 */
export async function readFunding(
  page: Page,
  token: string,
  form: PayForm | undefined,
  charge: PayPalCharge,
): Promise<FundingRead> {
  const url = new URL(page.url());
  const origin = url.origin;
  const request = page.context().request;
  const trpc = (procedure: string) => ({
    url: `${origin}/pay/api/trpc/xoos.${procedure}?batch=1&token=${encodeURIComponent(token)}`,
    headers: {
      "x-trpc-source": "nextjs-react",
      "x-trpc-token": token,
      origin,
      referer: `${origin}/pay?token=${encodeURIComponent(token)}`,
    },
  });
  const json = (res: { ok(): boolean; json(): Promise<unknown> }) =>
    res.ok() ? res.json() : Promise.resolve(null);
  if (form?.fundingInstrumentId) {
    // PayPal's client sends `undefined` (pay in full) through superjson.
    const selection = trpc("getFundingSelection");
    const summary = trpc("getCheckoutSummary");
    const input = encodeURIComponent(JSON.stringify({ 0: { json: { skipRewards: true } } }));
    const [funding, total] = await Promise.all([
      request
        .post(selection.url, {
          headers: { ...selection.headers, "content-type": "application/json" },
          data: { 0: { json: null, meta: { values: ["undefined"] } } },
          timeout: 15_000,
        })
        .then(json)
        .catch(() => null),
      request
        .get(`${summary.url}&input=${input}`, { headers: summary.headers, timeout: 15_000 })
        .then(json)
        .catch(() => null),
    ]);
    const stated = amountOf(
      (total as [{ result?: { data?: { json?: { payments?: { total?: Amount } } } } }] | null)?.[0]
        ?.result?.data?.json?.payments?.total,
    );
    if (!stated || stated.currency !== charge.currency || !same(stated.value, charge.value)) {
      return { ok: false, reason: "PayPal's checkout summary does not state its order's total" };
    }
    const read = fundingFromSelection(funding, form, charge);
    return read.ok
      ? {
          ok: true,
          funding: {
            ...read.funding,
            sources: ["xoos.getCheckoutSummary", ...read.funding.sources],
          },
        }
      : read;
  }
  if (url.pathname === "/pay" || url.pathname.startsWith("/pay/")) {
    return { ok: false, reason: "PayPal's pay form names no funding instrument" };
  }
  const answer = await request
    .post(`${origin}/graphql?GetFundingOptions`, {
      headers: {
        "content-type": "application/json",
        "x-app-name": "smart-payment-buttons",
        "paypal-client-context": token,
      },
      data: { query: LEGACY_FUNDING, variables: { orderID: token } },
      timeout: 15_000,
    })
    .then(json)
    .catch(() => null);
  return fundingFromPlans(answer, charge);
}
