import type { Mandate } from "./schema.ts";

/**
 * Merchant category code table, version `v1`: the ISO 18245 codes a card mandate may allow, with
 * their English names. Entries are only ever appended. Codes whose authorizations change after
 * approval (fuel, lodging, car rental) and codes for cash or quasi-cash are left out.
 */
export const MCC_TABLE: {
  readonly version: "v1";
  readonly codes: readonly string[];
  readonly labels: Readonly<Record<string, string>>;
} = {
  version: "v1",
  codes: [
    "5411",
    "5441",
    "5462",
    "5499",
    "5812",
    "5814",
    "5300",
    "5310",
    "5311",
    "5651",
    "5661",
    "5691",
    "5732",
    "5734",
    "5912",
    "5941",
    "5942",
    "5945",
    "5977",
    "5992",
    "5995",
    "5999",
    "4111",
    "4121",
    "7832",
  ],
  labels: {
    "5411": "Grocery stores and supermarkets",
    "5441": "Candy, nut and confectionery stores",
    "5462": "Bakeries",
    "5499": "Food stores and coffee shops",
    "5812": "Restaurants",
    "5814": "Fast food restaurants",
    "5300": "Wholesale clubs",
    "5310": "Discount stores",
    "5311": "Department stores",
    "5651": "Family clothing stores",
    "5661": "Shoe stores",
    "5691": "Clothing stores",
    "5732": "Electronics stores",
    "5734": "Computer software stores",
    "5912": "Drug stores and pharmacies",
    "5941": "Sporting goods stores",
    "5942": "Book stores",
    "5945": "Hobby, toy and game shops",
    "5977": "Cosmetic stores",
    "5992": "Florists",
    "5995": "Pet shops and pet supplies",
    "5999": "Specialty retail stores",
    "4111": "Commuter transport",
    "4121": "Taxis and limousines",
    "7832": "Movie theaters",
  },
};

/** English names of the {@link MCC_TABLE} codes (ISO 18245). */
export const MCC_LABELS: Readonly<Record<string, string>> = MCC_TABLE.labels;

/**
 * The `checkout.allowed_merchants` id that stands for any merchant of a `card` mandate. It is then
 * the only merchant, and its `mcc` and `country` bind every card authorization.
 */
export const ANY_MERCHANT = "*";

/** The kinds of store each Google product category is sold at, as merchant category codes. */
const STORES_OF: Readonly<Record<string, readonly string[]>> = {
  "gpt:1": ["5995", "5411", "5310"],
  "gpt:166": ["5651", "5691", "5311", "5310"],
  "gpt:187": ["5661", "5941", "5651", "5311"],
  "gpt:8": ["5945", "5999", "5942"],
  "gpt:537": ["5651", "5311", "5310", "5945"],
  "gpt:222": ["5732", "5311", "5310"],
  "gpt:412": ["5814", "5812", "5499", "5462", "5411", "5441"],
  "gpt:469": ["5912", "5977", "5411"],
  "gpt:536": ["5310", "5311", "5992", "5999"],
  "gpt:783": ["5942", "5732"],
  "gpt:922": ["5999", "5310", "5942"],
  "gpt:2092": ["5734", "5732"],
  "gpt:988": ["5941", "5661", "5311"],
  "gpt:1239": ["5945", "5311", "5310"],
};
const ANY_STORE = ["5311", "5310", "5999"];

/** The merchant category codes a card mandate allows for what the mandate's categories name. */
export function storesFor(categories: readonly string[]): string[] {
  const codes = categories.flatMap((c) => STORES_OF[c] ?? []);
  return [...new Set(codes.length > 0 ? codes : ANY_STORE)];
}

/**
 * The mandate `m`, paid with single-use cards at any store of the merchant category codes `mcc`
 * in `country` instead of through PayPal: its rail, its card controls and its one merchant.
 */
export function onCardRail(m: Mandate, mcc: readonly string[], country = "US"): Mandate {
  return {
    ...m,
    payment: {
      ...m.payment,
      rail: "card",
      constraints: m.payment.constraints.map((c) =>
        c.type === "payment.allowed_payees"
          ? { type: "payment.card_controls", single_use: true, mcc_table: MCC_TABLE.version }
          : c,
      ),
    },
    checkout: {
      ...m.checkout,
      constraints: m.checkout.constraints.map((c) =>
        c.type === "checkout.allowed_merchants"
          ? { ...c, allowed: [{ id: ANY_MERCHANT, name: "Any store", mcc: [...mcc], country }] }
          : c,
      ),
    },
  };
}
