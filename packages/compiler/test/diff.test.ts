import { readFileSync } from "node:fs";
import { CATEGORY_TABLE, type Mandate, parseMandate } from "@keelson/mandate";
import { type EvalInput, evaluate } from "@keelson/policy";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { diffDrafts, mergeDrafts, type SystemFields, toMandate } from "../src/diff.ts";
import { CompileError, type Draft, DraftSchema } from "../src/draft.ts";

const demo: Mandate = parseMandate(
  JSON.parse(
    readFileSync(new URL("../../mandate/test/fixtures/demo-mandate.json", import.meta.url), "utf8"),
  ),
);

/** The draft for "Running shoes, size 10, under $100, free returns, by Friday" at RunFast. */
const draft = (): Draft =>
  DraftSchema.parse({
    currency: "USD",
    maxTotalMinor: 10000,
    budgetMinor: 10000,
    merchants: ["RunFast"],
    category: ["gpt:187"],
    attributes: { size_us: "10", color: "any" },
    returns: { minDays: 30, free: true },
    notAfter: "2026-11-13T23:59:59Z",
    quantityPerLine: 1,
    item: "Running shoes",
    subjective: ["look good"],
    summary: "Running shoes, size 10, under $100, free returns, by Friday",
  });

const system: SystemFields = {
  mid: demo.mid,
  iat: demo.iat,
  nonce: demo.nonce,
  mode: demo.mode,
  user: demo.user,
  agent: demo.agent,
  consent: demo.consent,
  policy: demo.policy,
  risk_data: demo.risk_data,
  merchants: [
    {
      id: "mrc_runfast",
      name: "RunFast",
      website: "https://runfast.example",
      paypal_merchant_id: "MERCH7XK2Q9LD",
    },
    {
      id: "mrc_trailhub",
      name: "Trail Hub",
      website: "https://www.trailhub.example",
      paypal_merchant_id: "MERCH2TRAILHB",
    },
  ],
};
const promptHash = demo.intent.prompt_hash;

const sku = { sku: "sku-trail-10", size: "10", color: "black" };
const demoCart = (mandate: Mandate): EvalInput => ({
  mandate,
  budgetLeftMinor: 10_000,
  agent: `${mandate.agent.operator.agent_registry}/${mandate.agent.operator.agent_id}`,
  context: {
    currency: "USD",
    total_minor: 9400,
    merchant: "mrc_runfast",
    categories: ["gpt:187"],
    variants: [sku],
    max_line_qty: 1,
    max_unit_minor: 9400,
    return_days: 30,
    returns_free: true,
    quantities: [[sku, 1]],
  },
  now: new Date("2026-11-05T17:02:11.250Z"),
  evidence: { total: ["paypal.authorization.amount"] },
  mandateHash: new Uint8Array(32).fill(0x11),
  cartHash: new Uint8Array(32).fill(0x22),
});
const hash = (c: string) => `sha256:${c.repeat(64)}`;
const meta = {
  cedar_policy: "4.14.0",
  lang: "1.3.1",
  symcc: "0.8.1",
  cvc5: "1.3.1",
  oci_digest: hash("a"),
  canonicalizer: hash("b"),
  proof_bundle_hash: hash("c"),
};

describe("DraftSchema", () => {
  it("rejects unknown keys, attributes and categories", () => {
    expect(() => DraftSchema.parse({ ...draft(), extra: 1 })).toThrow();
    expect(() => DraftSchema.parse({ ...draft(), attributes: { width: "wide" } })).toThrow();
    expect(() => DraftSchema.parse({ ...draft(), category: ["shoes"] })).toThrow();
  });

  it("requires integer amounts and an RFC 3339 deadline", () => {
    expect(() => DraftSchema.parse({ ...draft(), maxTotalMinor: 99.5 })).toThrow();
    expect(() => DraftSchema.parse({ ...draft(), notAfter: "Friday" })).toThrow();
    expect(DraftSchema.parse({ ...draft(), notAfter: "2026-11-13T23:59:59-05:00" }).notAfter).toBe(
      "2026-11-13T23:59:59-05:00",
    );
  });
});

describe("diffDrafts", () => {
  it("finds no difference between identical drafts", () => {
    expect(diffDrafts(draft(), draft())).toEqual([]);
  });

  it("compares merchants, categories and subjective fragments as sets", () => {
    const a = { ...draft(), merchants: ["RunFast", "Trail Hub"], subjective: ["x", "y"] };
    const b = {
      ...draft(),
      merchants: ["Trail Hub", "RunFast", "RunFast"],
      subjective: ["y", "x"],
    };
    expect(diffDrafts(a, b)).toEqual([]);
  });

  it("names each differing field with both values", () => {
    const b = { ...draft(), maxTotalMinor: 9000, attributes: { size_us: "10.5" } };
    expect(diffDrafts(draft(), b)).toEqual([
      { field: "maxTotalMinor", a: 10000, b: 9000 },
      { field: "attributes", a: { size_us: "10", color: "any" }, b: { size_us: "10.5" } },
    ]);
  });
});

const dir = system.merchants;

/** The error code and fields a call throws. */
function failure(f: () => unknown): { code: string; fields: readonly string[] } {
  try {
    f();
  } catch (e) {
    if (!(e instanceof CompileError)) throw e;
    return { code: e.code, fields: e.fields };
  }
  throw new Error("expected a CompileError");
}

describe("mergeDrafts", () => {
  it("keeps the stated cap, deadline and quantity and marks them ambiguous when one is unstated", () => {
    const unstated = { ...draft(), maxTotalMinor: null, notAfter: null, quantityPerLine: null };
    for (const [a, b] of [
      [unstated, draft()],
      [draft(), unstated],
    ] as const) {
      const r = mergeDrafts(a, b, dir);
      expect(r.draft.maxTotalMinor).toBe(10000);
      expect(r.draft.notAfter).toBe("2026-11-13T23:59:59Z");
      expect(r.draft.quantityPerLine).toBe(1);
      expect(r.ambiguous).toEqual(["maxTotalMinor", "notAfter", "quantityPerLine"]);
    }
  });

  it("keeps an unstated field unstated and ambiguous when neither draft states it", () => {
    const unstated = { ...draft(), notAfter: null, quantityPerLine: null };
    const r = mergeDrafts(unstated, unstated, dir);
    expect(r.draft.notAfter).toBeNull();
    expect(r.draft.quantityPerLine).toBeNull();
    expect(r.ambiguous).toEqual(["notAfter", "quantityPerLine"]);
  });

  it("takes the lower amount and marks it ambiguous", () => {
    const r = mergeDrafts(draft(), { ...draft(), maxTotalMinor: 9000 }, dir);
    expect(r.draft.maxTotalMinor).toBe(9000);
    expect(r.ambiguous).toEqual(["maxTotalMinor"]);
    expect(r.singleSource).toBe(false);
  });

  it("takes the lower budget and quantity and the higher return days", () => {
    const r = mergeDrafts(
      { ...draft(), budgetMinor: 30000, quantityPerLine: 1, returns: { minDays: 14, free: true } },
      { ...draft(), budgetMinor: 20000, quantityPerLine: 2, returns: { minDays: 30, free: true } },
      dir,
    );
    expect(r.draft.budgetMinor).toBe(20000);
    expect(r.draft.quantityPerLine).toBe(1);
    expect(r.draft.returns).toEqual({ minDays: 30, free: true });
    expect(r.ambiguous).toEqual(["budgetMinor", "returns", "quantityPerLine"]);
  });

  it("requires free returns when either draft does", () => {
    const r = mergeDrafts(
      { ...draft(), returns: { minDays: 30, free: false } },
      { ...draft(), returns: { minDays: 30, free: true } },
      dir,
    );
    expect(r.draft.returns).toEqual({ minDays: 30, free: true });
    expect(r.ambiguous).toEqual(["returns"]);
  });

  it("keeps a return requirement that only one draft has", () => {
    const r = mergeDrafts({ ...draft(), returns: null }, draft(), dir);
    expect(r.draft.returns).toEqual({ minDays: 30, free: true });
    expect(r.ambiguous).toEqual(["returns"]);
  });

  it("takes the earlier deadline and treats equal instants as equal", () => {
    const r = mergeDrafts(draft(), { ...draft(), notAfter: "2026-11-13T12:00:00-05:00" }, dir);
    expect(r.draft.notAfter).toBe("2026-11-13T12:00:00-05:00");
    expect(r.ambiguous).toEqual(["notAfter"]);
    const same = mergeDrafts(draft(), { ...draft(), notAfter: "2026-11-13T18:59:59-05:00" }, dir);
    expect(same.ambiguous).toEqual([]);
  });

  it("takes the concrete attribute over an open one", () => {
    const r = mergeDrafts(
      { ...draft(), attributes: { size_us: "10", color: "any" } },
      { ...draft(), attributes: { color: "black" } },
      dir,
    );
    expect(r.draft.attributes).toEqual({ size_us: "10", color: "black" });
    expect(r.ambiguous).toEqual(["attributes"]);
  });

  it("fails on two different concrete attributes, in either order", () => {
    const a = { ...draft(), attributes: { size_us: "9", color: "red" } };
    const b = { ...draft(), attributes: { size_us: "10", color: "black" } };
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      expect(failure(() => mergeDrafts(x, y, dir))).toEqual({
        code: "conflict",
        fields: ["attributes.size_us", "attributes.color"],
      });
    }
  });

  it("fails on different currencies before comparing amounts", () => {
    expect(
      failure(() =>
        mergeDrafts(draft(), { ...draft(), currency: "JPY", maxTotalMinor: 5000 }, dir),
      ),
    ).toEqual({ code: "conflict", fields: ["currency"] });
  });

  it("intersects merchants after resolving them to directory ids", () => {
    const r = mergeDrafts(
      { ...draft(), merchants: ["RunFast", "Trail Hub"], category: ["gpt:187", "gpt:166"] },
      { ...draft(), merchants: ["trailhub.example", "Shoe Barn"], category: ["gpt:187"] },
      dir,
    );
    expect(r.draft.merchants).toEqual(["mrc_trailhub"]);
    expect(r.draft.category).toEqual(["gpt:187"]);
    expect(r.ambiguous).toEqual(["merchants", "category"]);
    const same = mergeDrafts(draft(), { ...draft(), merchants: ["runfast.example"] }, dir);
    expect(same.draft.merchants).toEqual(["mrc_runfast"]);
    expect(same.ambiguous).toEqual([]);
  });

  it("treats a draft without merchants or categories as no constraint", () => {
    const r = mergeDrafts({ ...draft(), merchants: [], category: [] }, draft(), dir);
    expect(r.draft.merchants).toEqual(["mrc_runfast"]);
    expect(r.draft.category).toEqual(["gpt:187"]);
    expect(r.ambiguous).toEqual(["merchants", "category"]);
    const none = mergeDrafts({ ...draft(), merchants: [] }, { ...draft(), merchants: [] }, dir);
    expect(none.draft.merchants).toEqual([]);
    expect(none.ambiguous).toEqual(["merchants"]);
  });

  it("fails on disjoint merchants or categories and on no category at all", () => {
    expect(
      failure(() => mergeDrafts(draft(), { ...draft(), merchants: ["Trail Hub"] }, dir)),
    ).toEqual({ code: "conflict", fields: ["merchants"] });
    expect(failure(() => mergeDrafts(draft(), { ...draft(), category: ["gpt:166"] }, dir))).toEqual(
      { code: "conflict", fields: ["category"] },
    );
    expect(
      failure(() => mergeDrafts({ ...draft(), category: [] }, { ...draft(), category: [] }, dir)),
    ).toEqual({ code: "no_category", fields: ["category"] });
  });

  it("fails when a draft names merchants and none resolves", () => {
    expect(
      failure(() => mergeDrafts({ ...draft(), merchants: ["Shoe Barn"] }, draft(), dir)),
    ).toEqual({ code: "no_merchant", fields: ["merchants"] });
  });

  it("unions subjective fragments", () => {
    const r = mergeDrafts(draft(), { ...draft(), subjective: ["comfy", "look good"] }, dir);
    expect(r.draft.subjective).toEqual(["comfy", "look good"]);
    expect(r.ambiguous).toEqual(["subjective"]);
  });

  it("rejects an invalid draft with a typed error", () => {
    const bad = { ...draft(), notAfter: "soon" } as Draft;
    expect(failure(() => mergeDrafts(bad, draft(), dir))).toEqual({
      code: "invalid_draft",
      fields: ["notAfter"],
    });
  });

  it("marks every field ambiguous when only one draft exists", () => {
    const all = Object.keys(DraftSchema.shape);
    for (const r of [mergeDrafts(draft(), null, dir), mergeDrafts(null, draft(), dir)]) {
      expect(r.singleSource).toBe(true);
      expect(r.draft).toEqual(draft());
      expect(r.ambiguous).toEqual(all);
    }
  });

  it("throws when both drafts are missing", () => {
    expect(failure(() => mergeDrafts(null, null, dir)).code).toBe("both_failed");
  });
});

describe("toMandate", () => {
  it("builds a mandate that parses and allows the demo cart", () => {
    const { mandate, ambiguous } = toMandate(draft(), system, { promptHash });
    expect(parseMandate(mandate)).toEqual(mandate);
    expect(ambiguous).toEqual([]);
    expect(mandate.checkout.constraints).toEqual([
      { type: "checkout.allowed_merchants", allowed: [system.merchants[0]] },
      {
        type: "checkout.line_items",
        items: [{ id: "l1", acceptable_items: [{ id: "*", title: "Running shoes" }], quantity: 1 }],
      },
      { type: "keelson.category", allow: ["gpt:187"], deny: [] },
      { type: "keelson.attributes", must: { size_us: "10", color: "any" } },
      { type: "keelson.returns", min_days: 30, free: true },
    ]);
    expect(mandate.payment).toEqual({
      rail: "paypal",
      currency: "USD",
      constraints: [
        { type: "payment.amount_range", max: 10000, currency: "USD" },
        { type: "payment.budget", max: 10000, currency: "USD" },
        { type: "payment.allowed_payees", allowed: [{ paypal_merchant_id: "MERCH7XK2Q9LD" }] },
        { type: "payment.execution_date", not_after: "2026-11-13T23:59:59Z" },
      ],
    });
    expect(mandate.intent.subjective).toEqual(["look good"]);
    expect(mandate.exp).toBe(Date.parse("2026-11-13T23:59:59Z") / 1000);
    expect(evaluate(demoCart(mandate), meta).decision).toBe("allow");
  });

  it("denies a cart over the merged amount", () => {
    const merged = mergeDrafts(draft(), { ...draft(), maxTotalMinor: 9000 }, dir);
    const { mandate, ambiguous } = toMandate(merged.draft, system, {
      promptHash,
      ambiguous: merged.ambiguous,
    });
    expect(ambiguous).toEqual(["total"]);
    expect(evaluate(demoCart(mandate), meta).decision).toBe("deny");
  });

  it("maps every draft field of a single-source draft to an ambiguous card field", () => {
    const merged = mergeDrafts(draft(), null, dir);
    const { ambiguous } = toMandate(merged.draft, system, {
      promptHash,
      ambiguous: merged.ambiguous,
    });
    expect(ambiguous).toEqual([
      "currency",
      "total",
      "budget",
      "merchant",
      "category",
      "variant",
      "return_policy",
      "deadline",
      "quantity",
      "items",
      "subjective",
    ]);
  });

  it("resolves merchants by name or domain and excludes unknown ones as ambiguous", () => {
    const { mandate, ambiguous } = toMandate(
      { ...draft(), merchants: ["runfast", "trailhub.example", "Shoe Barn"] },
      system,
      { promptHash },
    );
    const allowed = mandate.checkout.constraints.find(
      (c) => c.type === "checkout.allowed_merchants",
    );
    expect(allowed?.allowed.map((m) => m.id)).toEqual(["mrc_runfast", "mrc_trailhub"]);
    expect(ambiguous).toEqual(["merchant"]);
  });

  it("refuses to build a mandate when no named merchant resolves", () => {
    expect(
      failure(() => toMandate({ ...draft(), merchants: ["Shoe Barn"] }, system, { promptHash })),
    ).toEqual({ code: "no_merchant", fields: ["merchants"] });
  });

  it("allows every directory merchant when the draft names none, flagged ambiguous", () => {
    const { mandate, ambiguous } = toMandate({ ...draft(), merchants: [] }, system, {
      promptHash,
    });
    const allowed = mandate.checkout.constraints.find(
      (c) => c.type === "checkout.allowed_merchants",
    );
    expect(allowed?.allowed).toEqual(system.merchants);
    expect(ambiguous).toEqual(["merchant"]);
    expect(evaluate(demoCart(mandate), meta).decision).toBe("allow");
  });

  it("rejects an invalid draft with a typed error", () => {
    expect(
      failure(() => toMandate({ ...draft(), maxTotalMinor: Number.NaN }, system, { promptHash })),
    ).toEqual({ code: "invalid_draft", fields: ["maxTotalMinor"] });
    expect(
      failure(() => toMandate({ ...draft(), item: "x".repeat(300) }, system, { promptHash })),
    ).toEqual({
      code: "invalid_draft",
      fields: ["checkout.constraints.1.items.0.acceptable_items.0.title"],
    });
  });

  it("refuses to build a mandate without a category", () => {
    expect(() => toMandate({ ...draft(), category: [] }, system, { promptHash })).toThrow(
      expect.objectContaining({ code: "no_category" }),
    );
  });

  it("caps the lifetime at 30 days and marks the deadline ambiguous", () => {
    const { mandate, ambiguous } = toMandate(
      { ...draft(), notAfter: "2027-06-01T00:00:00Z" },
      system,
      { promptHash },
    );
    expect(mandate.exp).toBe(system.iat + 30 * 86400);
    expect(ambiguous).toEqual(["deadline"]);
    expect(parseMandate(mandate)).toEqual(mandate);
  });

  it("asks for the cap when the request states none, never defaulting money", () => {
    expect(
      failure(() => toMandate({ ...draft(), maxTotalMinor: null }, system, { promptHash })),
    ).toEqual({ code: "needs_input", fields: ["maxTotalMinor"] });
  });

  it("gives an unstated deadline seven days and an unstated quantity one, both ambiguous", () => {
    const { mandate, ambiguous } = toMandate(
      { ...draft(), notAfter: null, quantityPerLine: null },
      system,
      { promptHash },
    );
    expect(mandate.exp).toBe(system.iat + 7 * 86400);
    const line = mandate.checkout.constraints.find((c) => c.type === "checkout.line_items");
    expect(line?.type === "checkout.line_items" && line.items[0]?.quantity).toBe(1);
    expect(ambiguous).toEqual(["deadline", "quantity"]);
    expect(parseMandate(mandate)).toEqual(mandate);
  });

  it("refuses a deadline that is not after iat", () => {
    expect(() =>
      toMandate({ ...draft(), notAfter: "2026-11-01T00:00:00Z" }, system, { promptHash }),
    ).toThrow(expect.objectContaining({ code: "deadline_passed" }));
  });

  it("omits attributes and returns the draft leaves open", () => {
    const { mandate } = toMandate({ ...draft(), attributes: {}, returns: null }, system, {
      promptHash,
    });
    const types = mandate.checkout.constraints.map((c) => c.type);
    expect(types).toEqual([
      "checkout.allowed_merchants",
      "checkout.line_items",
      "keelson.category",
    ]);
    expect(parseMandate(mandate)).toEqual(mandate);
  });
});

describe("merging two drafts", () => {
  const names = [
    ...dir.flatMap((m) => [
      m.name,
      m.name.toLowerCase(),
      ...(m.website ? [new URL(m.website).hostname] : []),
      m.id,
    ]),
    "Shoe Barn",
  ];
  const categories = ["gpt:187", "gpt:166", "gpt:988"];
  const arbDraft: fc.Arbitrary<Draft> = fc.record({
    currency: fc.constantFrom<Draft["currency"]>("USD", "USD", "USD", "EUR"),
    maxTotalMinor: fc.option(fc.integer({ min: 1000, max: 20000 }), { nil: null, freq: 10 }),
    budgetMinor: fc.integer({ min: 1000, max: 30000 }),
    merchants: fc.uniqueArray(fc.constantFrom(...names), { maxLength: 3 }),
    category: fc.uniqueArray(fc.constantFrom(...categories), { maxLength: 2 }),
    attributes: fc.record(
      { size_us: fc.constantFrom("9", "10", "any"), color: fc.constantFrom("black", "red", "any") },
      { requiredKeys: [] },
    ),
    returns: fc.option(fc.record({ minDays: fc.constantFrom(0, 14, 30), free: fc.boolean() }), {
      nil: null,
    }),
    notAfter: fc.constantFrom(
      null,
      "2026-11-08T00:00:00Z",
      "2026-11-13T23:59:59Z",
      "2026-11-13T18:59:59-05:00",
      "2026-11-20T09:00:00+01:00",
    ),
    quantityPerLine: fc.option(fc.integer({ min: 1, max: 3 }), { nil: null, freq: 4 }),
    item: fc.constantFrom("Running shoes", "Trail shoes"),
    subjective: fc.uniqueArray(fc.constantFrom("look good", "comfy"), { maxLength: 2 }),
    summary: fc.constantFrom("Running shoes", "Shoes by Friday"),
  });
  const arbCart = fc.record({
    currency: fc.constantFrom<string>("USD", "USD", "USD", "EUR"),
    total: fc.integer({ min: 500, max: 21000 }),
    merchant: fc.constantFrom(...dir.map((m) => m.id)),
    categories: fc.uniqueArray(fc.constantFrom(...categories, "gpt:222"), {
      minLength: 1,
      maxLength: 2,
    }),
    size: fc.constantFrom<string>("9", "10"),
    color: fc.constantFrom<string>("black", "red"),
    qty: fc.integer({ min: 1, max: 3 }),
    returnDays: fc.constantFrom<number>(0, 14, 30, 60),
    free: fc.boolean(),
    /** Whether to move the cart inside the merged mandate, all but the `loose` dimension. */
    fit: fc.boolean(),
    loose: fc.constantFrom(
      "none",
      "currency",
      "total",
      "merchant",
      "categories",
      "variant",
      "qty",
      "returns",
    ),
  });
  type Cart = typeof arbCart extends fc.Arbitrary<infer T> ? T : never;

  const allows = (mandate: Mandate, cart: Cart): boolean => {
    const v = { sku: "sku-any", size: cart.size, color: cart.color };
    return (
      evaluate(
        {
          ...demoCart(mandate),
          budgetLeftMinor: 1_000_000,
          context: {
            currency: cart.currency,
            total_minor: cart.total,
            merchant: cart.merchant,
            categories: cart.categories,
            variants: [v],
            max_line_qty: cart.qty,
            max_unit_minor: Math.ceil(cart.total / cart.qty),
            return_days: cart.returnDays,
            returns_free: cart.free,
            quantities: [[v, cart.qty]],
          },
        },
        meta,
      ).decision === "allow"
    );
  };
  /** Moves a cart inside a mandate's bounds, except for its `loose` dimension. */
  const fitTo = (m: Mandate, cart: Cart): Cart => {
    if (!cart.fit) return cart;
    const c = { ...cart };
    const find = <T extends string>(type: T) =>
      [...m.payment.constraints, ...m.checkout.constraints].find((k) => k.type === type);
    const cap = find("payment.amount_range") as { max: number };
    const merchants = find("checkout.allowed_merchants") as { allowed: { id: string }[] };
    const cats = find("keelson.category") as { allow: string[] };
    const must = (find("keelson.attributes") as { must: Record<string, string> } | undefined)?.must;
    const returns = find("keelson.returns") as { min_days: number; free: boolean } | undefined;
    const qty = (find("checkout.line_items") as { items: { quantity: number }[] }).items[0]
      ?.quantity;
    if (c.loose !== "currency") c.currency = m.payment.currency;
    if (c.loose !== "total") c.total = Math.min(c.total, cap.max);
    if (c.loose !== "merchant" && !merchants.allowed.some((x) => x.id === c.merchant)) {
      c.merchant = merchants.allowed[c.total % merchants.allowed.length]?.id as string;
    }
    if (c.loose !== "categories")
      c.categories = [cats.allow[c.total % cats.allow.length] as string];
    if (c.loose !== "variant") {
      if (must?.size_us && must.size_us !== "any") c.size = must.size_us;
      if (must?.color && must.color !== "any") c.color = must.color;
    }
    if (c.loose !== "qty") c.qty = Math.min(c.qty, qty ?? 1);
    if (c.loose !== "returns" && returns) {
      c.returnDays = Math.max(c.returnDays, returns.min_days);
      c.free ||= returns.free;
    }
    return c;
  };

  /**
   * A lone draft's mandate, reading no categories as every category and an unstated cap,
   * deadline or quantity as the other draft's: what a draft leaves unstated constrains nothing.
   */
  const alone = (d: Draft, other: Draft): Mandate =>
    toMandate(
      {
        ...d,
        category: d.category.length ? d.category : [...CATEGORY_TABLE.ids],
        maxTotalMinor: d.maxTotalMinor ?? other.maxTotalMinor,
        notAfter: d.notAfter ?? other.notAfter,
        quantityPerLine: d.quantityPerLine ?? other.quantityPerLine,
      },
      system,
      { promptHash },
    ).mandate;

  it("is symmetric", () => {
    fc.assert(
      fc.property(arbDraft, arbDraft, (a, b) => {
        const run = (x: Draft, y: Draft) => {
          try {
            return mergeDrafts(x, y, dir);
          } catch (e) {
            if (!(e instanceof CompileError)) throw e;
            return { code: e.code, fields: [...e.fields].sort() };
          }
        };
        expect(run(a, b)).toEqual(run(b, a));
      }),
      { numRuns: 1000 },
    );
  });

  it("never allows a cart that either draft alone denies", () => {
    let allowed = 0;
    fc.assert(
      fc.property(
        arbDraft,
        arbDraft,
        fc.array(arbCart, { minLength: 8, maxLength: 8 }),
        (a, b, carts) => {
          let merged: Mandate;
          try {
            const r = mergeDrafts(a, b, dir);
            merged = toMandate(r.draft, system, { promptHash, ambiguous: r.ambiguous }).mandate;
          } catch (e) {
            if (!(e instanceof CompileError)) throw e;
            return;
          }
          const ma = alone(a, b);
          const mb = alone(b, a);
          for (const random of carts) {
            const cart = fitTo(merged, random);
            if (!allows(merged, cart)) continue;
            allowed++;
            expect(allows(ma, cart)).toBe(true);
            expect(allows(mb, cart)).toBe(true);
          }
          expect(merged.exp).toBeLessThanOrEqual(Math.min(ma.exp, mb.exp));
        },
      ),
      { numRuns: 1000 },
    );
    expect(allowed).toBeGreaterThan(200);
    // 1,000 runs of eight carts each take about 6 s on a CI runner.
  }, 30_000);
});
