import { type Json, jcs } from "@keelson/core";
import {
  ANY_ITEM,
  type FieldId,
  MAX_LIFETIME_SECONDS,
  type Mandate,
  parseMandate,
} from "@keelson/mandate";
import { CompileError, DRAFT_FIELDS, type Draft, type DraftField } from "./draft.ts";

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

const open = (v: string | undefined) => v === undefined || v === "any";
const constrained = (x: string | undefined, y: string | undefined) => (open(x) && !open(y) ? y : x);

function stricter(a: Draft, b: Draft): Draft {
  const attributes: Draft["attributes"] = {};
  const size = constrained(a.attributes.size_us, b.attributes.size_us);
  const color = constrained(a.attributes.color, b.attributes.color);
  if (size !== undefined) attributes.size_us = size;
  if (color !== undefined) attributes.color = color;
  return {
    ...a,
    maxTotalMinor: Math.min(a.maxTotalMinor, b.maxTotalMinor),
    budgetMinor: Math.min(a.budgetMinor, b.budgetMinor),
    merchants: unique(a.merchants.filter((m) => b.merchants.includes(m))),
    category: unique(a.category.filter((c) => b.category.includes(c))),
    attributes,
    returns:
      a.returns && b.returns
        ? {
            minDays: Math.max(a.returns.minDays, b.returns.minDays),
            free: a.returns.free || b.returns.free,
          }
        : (a.returns ?? b.returns),
    notAfter: Date.parse(b.notAfter) < Date.parse(a.notAfter) ? b.notAfter : a.notAfter,
    quantityPerLine: Math.min(a.quantityPerLine, b.quantityPerLine),
    subjective: unique([...a.subjective, ...b.subjective]),
  };
}

/**
 * Merges the drafts of two independent compilations. Where they differ, the merge takes the
 * stricter value and lists the field as ambiguous; a field with no stricter value (currency,
 * item, summary, conflicting attributes) keeps `a`'s. A lone draft is single-source: every field
 * is ambiguous.
 */
export function mergeDrafts(
  a: Draft | null,
  b: Draft | null,
): { draft: Draft; ambiguous: DraftField[]; singleSource: boolean } {
  if (a && b) {
    const ambiguous = diffDrafts(a, b).map((d) => d.field);
    return { draft: ambiguous.length ? stricter(a, b) : a, ambiguous, singleSource: false };
  }
  const draft = a ?? b;
  if (!draft) throw new CompileError("both_failed");
  return { draft, ambiguous: [...DRAFT_FIELDS], singleSource: true };
}

const CARD_FIELD: Readonly<Record<DraftField, FieldId | undefined>> = {
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

/** Seconds since the epoch as an RFC 3339 UTC date-time without a fraction. */
const rfc3339 = (s: number) => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Assembles the mandate for a draft. The mandate accepts any item within the draft's categories
 * from the directory merchants the draft names; names that resolve to no merchant are dropped.
 * `zk.commitment` is zero until `prepareSigning` binds it. Returns the card fields to show as
 * ambiguous: the draft's `ambiguous` fields, merchants that did not resolve and a deadline cut to
 * the maximum lifetime.
 *
 * @throws {@link CompileError} `no_merchant` when no merchant resolves, `no_category` without a
 * category and `deadline_passed` when `notAfter` is not after `iat`.
 */
export function toMandate(
  draft: Draft,
  system: SystemFields,
  opts: { promptHash: string; ambiguous?: readonly DraftField[] },
): { mandate: Mandate; ambiguous: FieldId[] } {
  const ambiguous = new Set((opts.ambiguous ?? []).map((f) => CARD_FIELD[f]));
  const merchants: Merchant[] = [];
  for (const name of draft.merchants) {
    const m = resolve(name, system.merchants);
    if (!m) ambiguous.add("merchant");
    else if (!merchants.includes(m)) merchants.push(m);
  }
  if (merchants.length === 0) throw new CompileError("no_merchant", ["merchant"]);
  if (draft.category.length === 0) throw new CompileError("no_category", ["category"]);

  const deadline = Math.floor(Date.parse(draft.notAfter) / 1000);
  if (deadline <= system.iat) throw new CompileError("deadline_passed", ["deadline"]);
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

  const mandate = parseMandate({
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
