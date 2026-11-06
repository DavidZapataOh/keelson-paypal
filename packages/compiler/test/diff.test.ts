import { readFileSync } from "node:fs";
import { type Mandate, parseMandate } from "@keelson/mandate";
import { type EvalInput, evaluate } from "@keelson/policy";
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

describe("mergeDrafts", () => {
  it("takes the lower amount and marks it ambiguous", () => {
    const r = mergeDrafts(draft(), { ...draft(), maxTotalMinor: 9000 });
    expect(r.draft.maxTotalMinor).toBe(9000);
    expect(r.ambiguous).toEqual(["maxTotalMinor"]);
    expect(r.singleSource).toBe(false);
  });

  it("intersects merchants and categories", () => {
    const r = mergeDrafts(
      { ...draft(), merchants: ["RunFast", "Trail Hub"], category: ["gpt:187", "gpt:166"] },
      { ...draft(), merchants: ["Trail Hub", "Shoe Barn"], category: ["gpt:187"] },
    );
    expect(r.draft.merchants).toEqual(["Trail Hub"]);
    expect(r.draft.category).toEqual(["gpt:187"]);
    expect(r.ambiguous).toEqual(["merchants", "category"]);
  });

  it("takes the earlier deadline, the higher return days and the constrained attribute", () => {
    const r = mergeDrafts(
      { ...draft(), notAfter: "2026-11-13T23:59:59Z", returns: { minDays: 14, free: false } },
      {
        ...draft(),
        notAfter: "2026-11-13T12:00:00-05:00",
        returns: { minDays: 30, free: true },
        attributes: { size_us: "10", color: "black" },
      },
    );
    expect(r.draft.notAfter).toBe("2026-11-13T12:00:00-05:00");
    expect(r.draft.returns).toEqual({ minDays: 30, free: true });
    expect(r.draft.attributes).toEqual({ size_us: "10", color: "black" });
    expect(r.ambiguous).toEqual(["attributes", "returns", "notAfter"]);
  });

  it("keeps a return requirement that only one draft has", () => {
    expect(mergeDrafts({ ...draft(), returns: null }, draft()).draft.returns).toEqual({
      minDays: 30,
      free: true,
    });
  });

  it("marks every field ambiguous when only one draft exists", () => {
    const all = Object.keys(DraftSchema.shape);
    for (const r of [mergeDrafts(draft(), null), mergeDrafts(null, draft())]) {
      expect(r.singleSource).toBe(true);
      expect(r.draft).toEqual(draft());
      expect(r.ambiguous).toEqual(all);
    }
  });

  it("throws when both drafts are missing", () => {
    expect(() => mergeDrafts(null, null)).toThrow(CompileError);
    try {
      mergeDrafts(null, null);
    } catch (e) {
      expect((e as CompileError).code).toBe("both_failed");
    }
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
    const merged = mergeDrafts(draft(), { ...draft(), maxTotalMinor: 9000 });
    const { mandate, ambiguous } = toMandate(merged.draft, system, {
      promptHash,
      ambiguous: merged.ambiguous,
    });
    expect(ambiguous).toEqual(["total"]);
    expect(evaluate(demoCart(mandate), meta).decision).toBe("deny");
  });

  it("maps every draft field of a single-source draft to an ambiguous card field", () => {
    const merged = mergeDrafts(draft(), null);
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

  it("refuses to build a mandate when no merchant resolves", () => {
    for (const merchants of [["Shoe Barn"], []]) {
      try {
        toMandate({ ...draft(), merchants }, system, { promptHash });
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(CompileError);
        expect((e as CompileError).code).toBe("no_merchant");
        expect((e as CompileError).ambiguous).toEqual(["merchant"]);
      }
    }
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
