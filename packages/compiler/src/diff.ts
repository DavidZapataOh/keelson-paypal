import { type Json, jcs } from "@keelson/core";
import {
  ANY_ITEM,
  type FieldId,
  MAX_LIFETIME_SECONDS,
  type Mandate,
  MandateError,
  parseMandate,
} from "@keelson/mandate";
import { CompileError, DRAFT_FIELDS, type Draft, type DraftField, parseDraft } from "./draft.ts";

/** A merchant of the directory that draft merchant names resolve against. */
export type Merchant = Extract<
  Mandate["checkout"]["constraints"][number],
  { type: "checkout.allowed_merchants" }
>["allowed"][number];

/** The mandate fields that come from the system, never from a model. */
export interface SystemFields {
  mid: string;
  iat: number;
  nonce: string;
  mode: Mandate["mode"];
  user: Mandate["user"];
  agent: Mandate["agent"];
  consent: Mandate["consent"];
  policy: Mandate["policy"];
  risk_data: Mandate["risk_data"];
  /** The merchants a mandate may name. */
  merchants: readonly Merchant[];
}

export interface DraftDiff {
  field: DraftField;
  a: unknown;
  b: unknown;
}

const SETS: ReadonlySet<DraftField> = new Set(["merchants", "category", "subjective"]);

const unique = <T>(xs: readonly T[]): T[] => [...new Set(xs)];

function canonical(field: DraftField, value: unknown): string {
  const v = SETS.has(field) ? unique(value as string[]).sort() : value;
  return jcs(JSON.parse(JSON.stringify(v)) as Json);
}

/**
 * The fields on which two drafts differ, compared by their JCS encoding. Merchants, categories
 * and subjective fragments are compared as sets.
 */
export function diffDrafts(a: Draft, b: Draft): DraftDiff[] {
  return DRAFT_FIELDS.filter((f) => canonical(f, a[f]) !== canonical(f, b[f])).map((field) => ({
    field,
    a: a[field],
    b: b[field],
  }));
}

const ATTRIBUTES = ["size_us", "color"] as const;
const open = (v: string | undefined) => v === undefined || v === "any";
const smaller = (x: string, y: string) => (y < x ? y : x);

/**
 * Narrows two sets where an empty set means no constraint: a side with none takes the other's,
 * and two constraints intersect.
 */
function narrow(x: readonly string[], y: readonly string[]): string[] | undefined {
  if (x.length === 0) return [...y].sort();
  if (y.length === 0) return [...x].sort();
  const both = x.filter((v) => y.includes(v)).sort();
  return both.length ? both : undefined;
}

const sameSet = (x: readonly string[], y: readonly string[]) =>
  x.length === y.length && x.every((v) => y.includes(v));

/**
 * Merges the drafts of two independent compilations into one that is never wider than either.
 * A field the drafts differ on takes the narrower value and is listed as ambiguous: the lower
 * amounts and quantity, the earlier deadline, the stricter returns, the concrete attribute, and
 * the intersection of merchants (by directory id) and categories, where a draft with none
 * constrains nothing. Values the drafts disagree on that cannot be narrowed fail with
 * `conflict`; descriptive text (item, summary) takes the smaller value so the merge is
 * symmetric. A lone draft is single-source: every field is ambiguous.
 *
 * @throws {@link CompileError} `both_failed`, `invalid_draft`, `conflict` naming the fields,
 * `no_merchant` when a draft names merchants and none resolves, `no_category` when neither draft
 * names a category.
 */
export function mergeDrafts(
  a: Draft | null,
  b: Draft | null,
  directory: readonly Merchant[],
): { draft: Draft; ambiguous: DraftField[]; singleSource: boolean } {
  if (!a || !b) {
    const draft = a ?? b;
    if (!draft) throw new CompileError("both_failed");
    return { draft: parseDraft(draft), ambiguous: [...DRAFT_FIELDS], singleSource: true };
  }
  const x = parseDraft(a);
  const y = parseDraft(b);
  const ambiguous = new Set<DraftField>();
  const conflicts: string[] = [];
  if (x.currency !== y.currency) conflicts.push("currency");

  const attributes: Draft["attributes"] = {};
  for (const key of ATTRIBUTES) {
    const [u, v] = [x.attributes[key], y.attributes[key]];
    if (open(u) && open(v)) {
      if (u !== undefined && u === v) attributes[key] = u;
    } else if (open(u) || open(v)) {
      attributes[key] = (open(u) ? v : u) as string;
      ambiguous.add("attributes");
    } else if (u !== v) conflicts.push(`attributes.${key}`);
    else attributes[key] = u as string;
  }

  const mx = resolveAll(x.merchants, directory);
  const my = resolveAll(y.merchants, directory);
  if (mx.unresolved || my.unresolved || !sameSet(mx.ids, my.ids) || mx.ids.length === 0) {
    ambiguous.add("merchants");
  }
  const merchants = narrow(mx.ids, my.ids);
  if (!merchants) conflicts.push("merchants");

  if (x.category.length === 0 && y.category.length === 0) {
    throw new CompileError("no_category", ["category"]);
  }
  if (!sameSet(x.category, y.category)) ambiguous.add("category");
  const category = narrow(x.category, y.category);
  if (!category) conflicts.push("category");
  if (conflicts.length) throw new CompileError("conflict", conflicts);

  const least = (f: "maxTotalMinor" | "budgetMinor" | "quantityPerLine") => {
    if (x[f] !== y[f]) ambiguous.add(f);
    return Math.min(x[f], y[f]);
  };
  const text = (f: "item" | "summary") => {
    if (x[f] !== y[f]) ambiguous.add(f);
    return smaller(x[f], y[f]);
  };
  const returns =
    x.returns && y.returns
      ? {
          minDays: Math.max(x.returns.minDays, y.returns.minDays),
          free: x.returns.free || y.returns.free,
        }
      : (x.returns ?? y.returns);
  if (JSON.stringify(x.returns) !== JSON.stringify(y.returns)) ambiguous.add("returns");
  const [tx, ty] = [Date.parse(x.notAfter), Date.parse(y.notAfter)];
  if (tx !== ty) ambiguous.add("notAfter");
  const notAfter = tx < ty ? x.notAfter : ty < tx ? y.notAfter : smaller(x.notAfter, y.notAfter);
  if (!sameSet(x.subjective, y.subjective)) ambiguous.add("subjective");

  const draft: Draft = {
    currency: x.currency,
    maxTotalMinor: least("maxTotalMinor"),
    budgetMinor: least("budgetMinor"),
    merchants: merchants as string[],
    category: category as Draft["category"],
    attributes,
    returns,
    notAfter,
    quantityPerLine: least("quantityPerLine"),
    item: text("item"),
    subjective: unique([...x.subjective, ...y.subjective]).sort(),
    summary: text("summary"),
  };
  return {
    draft,
    ambiguous: DRAFT_FIELDS.filter((f) => ambiguous.has(f)),
    singleSource: false,
  };
}

/** The card row each draft field becomes; the summary has none. */
export const CARD_FIELD: Readonly<Record<DraftField, FieldId | undefined>> = {
  currency: "currency",
  maxTotalMinor: "total",
  budgetMinor: "budget",
  merchants: "merchant",
  category: "category",
  attributes: "variant",
  returns: "return_policy",
  notAfter: "deadline",
  quantityPerLine: "quantity",
  item: "items",
  subjective: "subjective",
  summary: undefined,
};

const CARD_ORDER = Object.values(CARD_FIELD).filter((f) => f !== undefined);

function host(s: string): string | undefined {
  try {
    return new URL(s.includes("://") ? s : `https://${s}`).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** The directory merchant a name, domain or id stands for. */
function resolve(name: string, directory: readonly Merchant[]): Merchant | undefined {
  const n = name.trim();
  const h = host(n);
  return directory.find(
    (m) =>
      m.id === n ||
      m.name.toLowerCase() === n.toLowerCase() ||
      (h !== undefined && h === host(m.website)),
  );
}

/**
 * Resolves draft merchant names to directory ids, in order and without repeats.
 *
 * @throws {@link CompileError} `no_merchant` when names are given and none resolves.
 */
function resolveAll(
  names: readonly string[],
  directory: readonly Merchant[],
): { ids: string[]; unresolved: boolean } {
  const ids: string[] = [];
  let unresolved = false;
  for (const name of names) {
    const m = resolve(name, directory);
    if (!m) unresolved = true;
    else if (!ids.includes(m.id)) ids.push(m.id);
  }
  if (names.length > 0 && ids.length === 0) throw new CompileError("no_merchant", ["merchants"]);
  return { ids, unresolved };
}

/** Seconds since the epoch as an RFC 3339 UTC date-time without a fraction. */
const rfc3339 = (s: number) => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Parses an assembled mandate; a draft value that breaks the format is `invalid_draft`. */
function build(m: unknown): Mandate {
  try {
    return parseMandate(m);
  } catch (e) {
    if (e instanceof MandateError) throw new CompileError("invalid_draft", [e.field]);
    throw e;
  }
}

/**
 * Assembles the mandate for a draft. The mandate accepts any item within the draft's categories
 * from the directory merchants the draft names, or from every directory merchant when it names
 * none; names that resolve to no merchant are dropped. `zk.commitment` is zero until
 * `prepareSigning` binds it. Returns the card fields to show as ambiguous: the draft's
 * `ambiguous` fields, a merchant set that is open or lost a name, and a deadline cut to the
 * maximum lifetime.
 *
 * @throws {@link CompileError} `invalid_draft`, `no_merchant` when names are given and none
 * resolves, `no_category` without a category and `deadline_passed` when `notAfter` is not after
 * `iat`.
 */
export function toMandate(
  input: Draft,
  system: SystemFields,
  opts: { promptHash: string; ambiguous?: readonly DraftField[] },
): { mandate: Mandate; ambiguous: FieldId[] } {
  const draft = parseDraft(input);
  const ambiguous = new Set((opts.ambiguous ?? []).map((f) => CARD_FIELD[f]));
  const { ids, unresolved } = resolveAll(draft.merchants, system.merchants);
  if (unresolved || ids.length === 0) ambiguous.add("merchant");
  const merchants = ids.length
    ? ids.map((id) => system.merchants.find((m) => m.id === id) as Merchant)
    : [...system.merchants];
  if (merchants.length === 0) throw new CompileError("no_merchant", ["merchants"]);
  if (draft.category.length === 0) throw new CompileError("no_category", ["category"]);

  const deadline = Math.floor(Date.parse(draft.notAfter) / 1000);
  if (deadline <= system.iat) throw new CompileError("deadline_passed", ["notAfter"]);
  const exp = Math.min(deadline, system.iat + MAX_LIFETIME_SECONDS);
  if (exp < deadline) ambiguous.add("deadline");

  const { currency } = draft;
  const checkout: Mandate["checkout"]["constraints"] = [
    { type: "checkout.allowed_merchants", allowed: merchants },
    {
      type: "checkout.line_items",
      items: [
        {
          id: "l1",
          acceptable_items: [{ id: ANY_ITEM, title: draft.item }],
          quantity: draft.quantityPerLine,
        },
      ],
    },
    { type: "keelson.category", allow: unique(draft.category), deny: [] },
  ];
  const must = Object.fromEntries(
    Object.entries(draft.attributes).filter((e): e is [string, string] => e[1] !== undefined),
  );
  if (Object.keys(must).length > 0) checkout.push({ type: "keelson.attributes", must });
  if (draft.returns) {
    checkout.push({
      type: "keelson.returns",
      min_days: draft.returns.minDays,
      free: draft.returns.free,
    });
  }

  const mandate = build({
    v: "keelson.mandate.1",
    mid: system.mid,
    iat: system.iat,
    nbf: system.iat,
    exp,
    nonce: system.nonce,
    mode: system.mode,
    user: system.user,
    agent: system.agent,
    payment: {
      rail: "paypal",
      currency,
      constraints: [
        { type: "payment.amount_range", max: draft.maxTotalMinor, currency },
        { type: "payment.budget", max: draft.budgetMinor, currency },
        {
          type: "payment.allowed_payees",
          allowed: unique(merchants.map((m) => m.paypal_merchant_id)).map((id) => ({
            paypal_merchant_id: id,
          })),
        },
        { type: "payment.execution_date", not_after: rfc3339(exp) },
      ],
    },
    checkout: { constraints: checkout },
    intent: {
      prompt_summary: draft.summary,
      prompt_hash: opts.promptHash,
      subjective: unique(draft.subjective),
    },
    policy: system.policy,
    consent: system.consent,
    zk: { commitment: `0x${"0".repeat(64)}` },
    risk_data: system.risk_data,
  });
  return { mandate, ambiguous: CARD_ORDER.filter((f) => ambiguous.has(f)) };
}
