import { CATEGORY_TABLE } from "@keelson/mandate";
import { compareStrings, get, isObject, isSafeInt, type JsonObject, sortedSet } from "./value.ts";

/** A `keelson.attributes` value that leaves the attribute unconstrained. */
const ANY = "any";

/** Why the `Mandate` entity cannot be built: a mandate field, or `cedar` when Cedar rejects it. */
export class EntityError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`${field}: ${reason}`);
    this.name = "EntityError";
    this.field = field;
  }
}

const invalid = (field: string, reason: string) => new EntityError(field, reason);

function str(v: unknown, field: string): string {
  if (typeof v !== "string") throw invalid(field, "expected string");
  return v;
}

/** An integer, read as [`isSafeInt`] reads JSON numbers. */
function int(v: unknown, field: string): number {
  if (!isSafeInt(v)) throw invalid(field, "expected integer");
  return v;
}

function array(v: unknown, field: string): unknown[] {
  if (!Array.isArray(v)) throw invalid(field, "expected array");
  return v;
}

/** The constraint of type `ty`, if any; a repeated type is an error rather than a first match. */
function constraint(m: unknown, group: string, ty: string): unknown {
  const field = `${group}.constraints`;
  const found = array(get(get(m, group), "constraints"), field).filter(
    (c) => get(c, "type") === ty,
  );
  if (found.length > 1) throw invalid(field, `more than one ${ty}`);
  return found[0];
}

/** A product variant. Absent size and color are omitted, never null. */
export interface Variant {
  sku: string;
  size?: string;
  color?: string;
}

/** Orders variants by sku, then size, then color, with an absent value first. */
export function compareVariants(a: Variant, b: Variant): number {
  const opt = (x: string | undefined, y: string | undefined) =>
    x === y ? 0 : x === undefined ? -1 : y === undefined ? 1 : compareStrings(x, y);
  return compareStrings(a.sku, b.sku) || opt(a.size, b.size) || opt(a.color, b.color);
}

/** The Cedar record for a variant. */
export function variantJson(v: Variant): JsonObject {
  const out: JsonObject = { sku: v.sku };
  if (v.size !== undefined) out.size = v.size;
  if (v.color !== undefined) out.color = v.color;
  return out;
}

/**
 * An agent's uid, `<registry>/<agent_id>`, its ERC-8004 identity; `undefined` unless `agentId`
 * is a canonical decimal.
 *
 * `agentId` never contains `/`, so the id is everything after the last `/` and the registry
 * everything before it, which makes the encoding injective even when the registry contains `/`.
 *
 * `EvalInput.agent` is this uid for the authenticated requester.
 */
export function agentUid(registry: string, agentId: string): string | undefined {
  return /^(0|[1-9][0-9]*)$/.test(agentId) ? `${registry}/${agentId}` : undefined;
}

/**
 * The [`agentUid`] of the agent a mandate authorizes, which the `agent` policy compares with the
 * requester. It is never the requester itself: that comes from the request's authentication.
 */
export function mandateAgent(m: unknown): string {
  const op = get(get(m, "agent"), "operator");
  const registry = str(get(op, "agent_registry"), "agent.operator.agent_registry");
  const id = str(get(op, "agent_id"), "agent.operator.agent_id");
  const uid = agentUid(registry, id);
  if (uid === undefined) throw invalid("agent.operator.agent_id", "expected a canonical decimal");
  return uid;
}

/** The instants the Rust engine's clock represents: years -9999 to 9999, in Unix milliseconds. */
const MIN_MS = -377_705_116_800_000n;
const MAX_MS = 253_402_300_799_999n;

const pad = (n: number, width: number) => String(n).padStart(width, "0");

function year(y: number): string {
  return y < 0 ? `-${pad(-y, 4)}` : pad(y, 4);
}

/** `YYYY-MM-DDThh:mm:ssZ`, the trace's `t_tee`, or `""` outside years -9999 to 9999. */
export function teeTime(t: Date): string {
  const ms = t.getTime();
  if (!Number.isFinite(ms) || BigInt(ms) < MIN_MS || BigInt(ms) > MAX_MS) return "";
  return (
    `${year(t.getUTCFullYear())}-${pad(t.getUTCMonth() + 1, 2)}-${pad(t.getUTCDate(), 2)}` +
    `T${pad(t.getUTCHours(), 2)}:${pad(t.getUTCMinutes(), 2)}:${pad(t.getUTCSeconds(), 2)}Z`
  );
}

/** The first and last instants of years 0000 to 9999 in Unix milliseconds. */
const FIRST_MS = -62_167_219_200_000n;
const LAST_MS = 253_402_300_799_999n;

/** `ms` when it lies within years 0000 to 9999. */
function epochMs(ms: bigint): number | undefined {
  return ms < FIRST_MS || ms > LAST_MS ? undefined : Number(ms);
}

/** The clock in Unix milliseconds when it lies within years 0000 to 9999. */
export function clockMs(t: Date): number | undefined {
  const ms = t.getTime();
  return Number.isFinite(ms) ? epochMs(BigInt(ms)) : undefined;
}

/** A window bound read from mandate `field`. */
function windowMs(ms: bigint, field: string): number {
  const v = epochMs(ms);
  if (v === undefined) throw invalid(field, "outside years 0000 to 9999");
  return v;
}

/**
 * The size and color the mandate's `keelson.attributes` require; `undefined` when an attribute
 * is absent or `any`, which leaves it unconstrained.
 */
export function attributes(m: unknown): { size?: string; color?: string } {
  const out: { size?: string; color?: string } = {};
  const attrs = constraint(m, "checkout", "keelson.attributes");
  if (attrs === undefined) return out;
  const must = get(attrs, "must");
  if (!isObject(must)) throw invalid("keelson.attributes.must", "expected record");
  // In UTF-8 byte order, as the Rust engine walks them: JavaScript enumerates index-like keys
  // first, so the first unsupported key would otherwise depend on the key spelling.
  for (const key of Object.keys(must).sort(compareStrings)) {
    const value = must[key];
    const field = `keelson.attributes.must.${key}`;
    const v = str(value, field);
    const slot = key === "size_us" ? "size" : key === "color" ? "color" : undefined;
    if (slot === undefined) throw invalid(field, "unsupported attribute");
    if (v === ANY) delete out[slot];
    else out[slot] = v;
  }
  return out;
}

/**
 * The allowed variants and the quantity bound: the smallest line quantity, since the policy set
 * has no arithmetic and the entity holds a single bound. It is 0, which denies every cart, when
 * the mandate has no lines.
 */
function variants(m: unknown): { variants: Variant[]; maxQty: number } {
  const { size, color } = attributes(m);
  const out = new Map<string, Variant>();
  let maxQty: number | undefined;
  const lines = constraint(m, "checkout", "checkout.line_items");
  if (lines !== undefined) {
    for (const line of array(get(lines, "items"), "checkout.line_items.items")) {
      const qty = int(get(line, "quantity"), "checkout.line_items.quantity");
      maxQty = maxQty === undefined ? qty : Math.min(maxQty, qty);
      const items = array(get(line, "acceptable_items"), "checkout.line_items.acceptable_items");
      for (const item of items) {
        const v: Variant = { sku: str(get(item, "id"), "checkout.line_items.acceptable_items.id") };
        if (size !== undefined) v.size = size;
        if (color !== undefined) v.color = color;
        out.set(v.sku, v);
      }
    }
  }
  return { variants: [...out.values()], maxQty: maxQty ?? 0 };
}

/** `keelson.category` allow minus deny; every category without a category constraint. */
function categories(m: unknown): string[] {
  const c = constraint(m, "checkout", "keelson.category");
  if (c === undefined) return sortedSet(CATEGORY_TABLE.ids);
  const ids = (key: string) => {
    const field = `keelson.category.${key}`;
    return array(get(c, key), field).map((v) => str(v, field));
  };
  const deny = new Set(ids("deny"));
  return sortedSet(ids("allow").filter((id) => !deny.has(id)));
}

/**
 * Orders Cedar records as Cedar orders set elements: by their entries in key order, each entry
 * by key and then value.
 */
function compareRecords(a: JsonObject, b: JsonObject): number {
  const ka = Object.keys(a).sort(compareStrings);
  const kb = Object.keys(b).sort(compareStrings);
  for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
    const x = ka[i] as string;
    const y = kb[i] as string;
    const c = compareStrings(x, y) || compareStrings(a[x] as string, b[y] as string);
    if (c !== 0) return c;
  }
  return ka.length - kb.length;
}

/**
 * The instant after the inclusive `payment.execution_date.not_after`, capped at `exp`, and the
 * field it comes from (`exp` when both are equal).
 */
function expiresAtMs(m: unknown): [bigint, string] {
  const exp = BigInt(int(get(m, "exp"), "exp")) * 1000n;
  const date = constraint(m, "payment", "payment.execution_date");
  if (date === undefined) throw invalid("payment.execution_date", "required");
  const field = "payment.execution_date.not_after";
  const notAfter = parseRfc3339Ms(str(get(date, "not_after"), field));
  if (notAfter === undefined) throw invalid(field, "invalid RFC 3339 date-time");
  const end = notAfter + 1n;
  return exp <= end ? [exp, "exp"] : [end, field];
}

/** The `Keelson::Mandate` entity in Cedar JSON form. */
export interface MandateEntity {
  uid: { type: "Keelson::Mandate"; id: string };
  attrs: JsonObject;
  parents: [];
}

/**
 * Builds the `Keelson::Mandate` entity from a decoded mandate and the budget left on it, reading
 * the fields in the same order as the Rust engine so the first error is the same.
 *
 * `budgetLeftMinor` is capped at `payment.budget.max`, so a wrong counter can never raise the
 * budget above what the user signed. Set attributes are in Cedar's order, so `attrs` is exactly
 * what Cedar serializes back.
 *
 * @throws {EntityError} when a field is missing or ill-typed.
 */
export function mandateEntity(m: unknown, budgetLeftMinor: number): MandateEntity {
  const mid = str(get(m, "mid"), "mid");
  const range = constraint(m, "payment", "payment.amount_range");
  if (range === undefined) throw invalid("payment.amount_range", "required");
  const budget = constraint(m, "payment", "payment.budget");
  if (budget === undefined) throw invalid("payment.budget", "required");
  const budgetLeft = Math.min(budgetLeftMinor, int(get(budget, "max"), "payment.budget.max"));
  const allowed = constraint(m, "checkout", "checkout.allowed_merchants");
  if (allowed === undefined) throw invalid("checkout.allowed_merchants", "required");
  const merchants = sortedSet(
    array(get(allowed, "allowed"), "checkout.allowed_merchants.allowed").map((x) =>
      str(get(x, "id"), "checkout.allowed_merchants.allowed.id"),
    ),
  );
  const returns = constraint(m, "checkout", "keelson.returns");
  let minReturnDays = 0;
  let returnsFree = false;
  if (returns !== undefined) {
    minReturnDays = int(get(returns, "min_days"), "keelson.returns.min_days");
    const free = get(returns, "free");
    if (typeof free !== "boolean") throw invalid("keelson.returns.free", "expected boolean");
    returnsFree = free;
  }
  const v = variants(m);

  const agent = mandateAgent(m);
  const currency = str(get(get(m, "payment"), "currency"), "payment.currency");
  const maxTotal = int(get(range, "max"), "payment.amount_range.max");
  const cats = categories(m);
  const notBefore = windowMs(BigInt(int(get(m, "nbf"), "nbf")) * 1000n, "nbf");
  const expiresAt = windowMs(...expiresAtMs(m));
  return {
    uid: { type: "Keelson::Mandate", id: mid },
    attrs: {
      agent: { __entity: { type: "Keelson::Agent", id: agent } },
      currency,
      max_total_minor: maxTotal,
      budget_left_minor: budgetLeft,
      merchants,
      categories: cats,
      variants: v.variants.map(variantJson).sort(compareRecords),
      max_qty_per_line: v.maxQty,
      not_before_ms: notBefore,
      expires_at_ms: expiresAt,
      min_return_days: minReturnDays,
      returns_free_required: returnsFree,
    },
    parents: [],
  };
}

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const daysIn = (y: number, month: number) =>
  month === 2 && y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : (DAYS[month - 1] as number);

/**
 * Parses an RFC 3339 date-time to Unix milliseconds, rounded down, exactly as the Rust engine's
 * `time` crate does: any single byte separates date and time, `Z` matches either case, any number
 * of fractional digits is allowed, and a leap second stands for the last nanosecond of a month.
 */
export function parseRfc3339Ms(text: string): bigint | undefined {
  const s = new TextEncoder().encode(text);
  let i = 0;
  const digits = (n: number): number | undefined => {
    let v = 0;
    for (let k = 0; k < n; k++) {
      const c = s[i + k];
      if (c === undefined || c < 0x30 || c > 0x39) return undefined;
      v = v * 10 + (c - 0x30);
    }
    i += n;
    return v;
  };
  const byte = (c: number) => {
    if (s[i] !== c) return false;
    i++;
    return true;
  };

  const y = digits(4);
  if (y === undefined || !byte(0x2d)) return undefined;
  const month = digits(2);
  if (month === undefined || month === 0 || !byte(0x2d)) return undefined;
  const day = digits(2);
  if (day === undefined || i >= s.length) return undefined;
  i++;
  const hour = digits(2);
  if (hour === undefined || !byte(0x3a)) return undefined;
  const minute = digits(2);
  if (minute === undefined || !byte(0x3a)) return undefined;
  let second = digits(2);
  if (second === undefined) return undefined;
  let nanos = 0;
  if (byte(0x2e)) {
    let multiplier = 100_000_000;
    let any = false;
    while (i < s.length && (s[i] as number) >= 0x30 && (s[i] as number) <= 0x39) {
      nanos += ((s[i] as number) - 0x30) * multiplier;
      multiplier = Math.floor(multiplier / 10);
      any = true;
      i++;
    }
    if (!any) return undefined;
  }
  let offsetMinutes = 0;
  if (s[i] === 0x5a || s[i] === 0x7a) {
    i++;
  } else {
    const sign = s[i] === 0x2b ? 1 : s[i] === 0x2d ? -1 : 0;
    if (sign === 0) return undefined;
    i++;
    const oh = digits(2);
    if (oh === undefined || oh > 23 || !byte(0x3a)) return undefined;
    const om = digits(2);
    if (om === undefined || om > 59) return undefined;
    offsetMinutes = sign * (oh * 60 + om);
  }
  if (i !== s.length) return undefined;

  const leap = second === 60;
  if (leap) {
    second = 59;
    nanos = 999_999_999;
  }
  if (month > 12 || day < 1 || day > daysIn(y, month)) return undefined;
  if (hour > 23 || minute > 59 || second > 59) return undefined;

  const local = new Date(0);
  local.setUTCFullYear(y, month - 1, day);
  local.setUTCHours(hour, minute, second);
  const utcMs =
    BigInt(local.getTime()) - BigInt(offsetMinutes) * 60_000n + BigInt(Math.floor(nanos / 1e6));
  if (leap) {
    const t = new Date(Number(utcMs));
    const last =
      t.getUTCHours() === 23 &&
      t.getUTCMinutes() === 59 &&
      t.getUTCSeconds() === 59 &&
      t.getUTCDate() === daysIn(t.getUTCFullYear(), t.getUTCMonth() + 1);
    if (!last) return undefined;
  }
  return utcMs;
}
