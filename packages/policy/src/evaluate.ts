import {
  type Context as CedarContext,
  checkParseContext,
  checkParseEntities,
  preparsePolicySet,
  type Response,
  statefulIsAuthorized,
} from "@cedar-policy/cedar-wasm";
import type { Json } from "@keelson/core";
import {
  attributes,
  cedarDatetime,
  compareVariants,
  datetimeJson,
  EntityError,
  type MandateEntity,
  mandateEntity,
  teeTime,
  type Variant,
  variantJson,
} from "./entity.ts";
import { binding, compile, type Extra, ExtrasError, extrasHash } from "./extras.ts";
import {
  BASE_SET,
  POLICY_SET_HASH,
  type PolicyInfo,
  policies,
  policyInfo,
  SCHEMA_HASH,
  SCHEMA_NAME,
  SCHEMA_SRC,
} from "./policy.ts";
import { type FieldTrace, TRACE_VERSION, type Trace } from "./trace.ts";
import { compareStrings, get, hex, isObject, type JsonObject, safe, sortedSet } from "./value.ts";

export type { Variant };

/**
 * The Cedar request context derived from a cart, plus the total quantity of each variant.
 *
 * `categories` and `variants` are sets: they are sorted and repeats dropped. `quantities` is keyed
 * by the elements of `variants` and is not part of the Cedar context: the evaluator uses it to
 * recompute `max_line_qty` after projecting the variants.
 */
export interface Context {
  currency: string;
  total_minor: number;
  merchant: string;
  categories: readonly string[];
  variants: readonly Variant[];
  max_line_qty: number;
  max_unit_minor: number;
  return_days: number;
  returns_free: boolean;
  quantities: ReadonlyArray<readonly [Variant, number]>;
}

/** Everything one evaluation reads. */
export interface EvalInput {
  /** The fully decoded mandate. */
  mandate: unknown;
  budgetLeftMinor: number;
  /** The agent principal id, as [`mandateAgent`] formats it. */
  agent: string;
  context: Context;
  /** The TEE clock. */
  now: Date;
  /**
   * The evidence sources for each field. A `ucp:` or `zktls:` source raises its color to green,
   * so those sources must come only from the engine's own verifiers.
   */
  evidence: Readonly<Record<string, readonly string[]>>;
  /** The mandate challenge `M`. */
  mandateHash: Uint8Array;
  cartHash: Uint8Array;
}

/** The engine build recorded in every trace. */
export interface EngineMeta {
  cedar_policy: string;
  lang: string;
  symcc: string;
  cvc5: string;
  oci_digest: string;
  canonicalizer: string;
  proof_bundle_hash: string;
}

const AGENT_TYPE = "Keelson::Agent";
const ACTION = { type: "Keelson::Action", id: "checkout" };
const EXTRAS_SET = "keelson+extras";

/**
 * The context and entity attributes each policy reads, shown as `observed` and `bound`. One key
 * is shown as its value, several as a record of them.
 */
const BINDINGS: Readonly<Record<string, readonly [readonly string[], readonly string[]]>> = {
  agent: [[], ["agent"]],
  sanity: [["max_line_qty", "max_unit_minor", "total_minor"], []],
  currency: [["currency"], ["currency"]],
  amount: [["total_minor"], ["max_total_minor"]],
  budget: [["total_minor"], ["budget_left_minor"]],
  merchant: [["merchant"], ["merchants"]],
  window: [["now"], ["expires_at", "not_before"]],
  quantity: [["max_line_qty"], ["max_qty_per_line"]],
  category: [["categories"], ["categories"]],
  variant: [["variants"], ["variants"]],
  returns: [["return_days"], ["min_return_days"]],
  returns_free: [["returns_free"], ["returns_free_required"]],
};

type Kind = "string" | "long" | "bool" | "strings" | "variants" | "datetime";

/** The context attributes of the `checkout` action and their types. */
const CONTEXT: readonly (readonly [string, Kind])[] = [
  ["currency", "string"],
  ["total_minor", "long"],
  ["merchant", "string"],
  ["categories", "strings"],
  ["variants", "variants"],
  ["max_line_qty", "long"],
  ["max_unit_minor", "long"],
  ["return_days", "long"],
  ["returns_free", "bool"],
  ["now", "datetime"],
];
const CONTEXT_ATTRS = new Set(CONTEXT.map(([attr]) => attr));

const sameKeys = (o: Record<string, unknown>, keys: readonly string[]) => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(o, k));
};

function accepts(kind: Kind, v: unknown): boolean {
  const strings = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === "string");
  switch (kind) {
    case "string":
      return typeof v === "string";
    case "long":
      return Number.isSafeInteger(v);
    case "bool":
      return typeof v === "boolean";
    case "strings":
      return strings(v);
    case "variants":
      return (
        Array.isArray(v) &&
        v.every(
          (x) =>
            isObject(x) &&
            typeof x.sku === "string" &&
            Object.entries(x).every(
              ([k, s]) => (k === "sku" || k === "size" || k === "color") && typeof s === "string",
            ),
        )
      );
    case "datetime": {
      const e = get(v, "__extn");
      return (
        isObject(v) &&
        sameKeys(v, ["__extn"]) &&
        isObject(e) &&
        sameKeys(e, ["fn", "arg"]) &&
        e.fn === "datetime" &&
        typeof e.arg === "string"
      );
    }
  }
}

/** Errors met while evaluating, and the policies they keep from passing. */
class Faults {
  readonly errors: string[] = [];
  readonly policies = new Set<string>();

  add(policy: string | undefined, code: string): void {
    this.errors.push(code);
    if (policy !== undefined) this.policies.add(policy);
  }
}

/**
 * Evaluates a cart against a mandate with the policies [`compileExtras`] builds from `extras`
 * added to the policy set, emitting the same `keelson.eval/1` trace as the Rust engine. Fails
 * closed: any error denies and is recorded.
 *
 * The context passed to Cedar is `input.context` projected onto the attributes the mandate
 * constrains: each variant keeps its `size` only when `keelson.attributes` requires a `size_us`,
 * and its `color` only when it requires a `color`. The quantities of variants that become equal
 * are added, and `max_line_qty` is the largest of those sums.
 *
 * The trace `errors` are the Rust engine's stable codes: `context.invalid`,
 * `context.missing:<attr>`, `context.type:<attr>`, `context.extra:<attr>`,
 * `context.empty:variants|categories`, `context.quantities`, `entity.invalid:<field>|cedar`,
 * `request.invalid`, `policy.error:<id>` and `extras.invalid:<n>|too_many|cedar`.
 */
export function evaluate(input: EvalInput, meta: EngineMeta, extras: readonly Extra[] = []): Trace {
  const faults = new Faults();
  const context = project(input, faults);
  return run(input, context, faults, extras, meta);
}

/**
 * Evaluates `context`, a context in Cedar JSON form such as a trace records, in place of the
 * projection of `input.context`, to replay a recorded evaluation. It applies the same checks as
 * [`evaluate`], except those on the quantities, which a recorded context does not carry.
 */
export function evaluateContext(
  input: Omit<EvalInput, "context">,
  context: unknown,
  meta: EngineMeta,
  extras: readonly Extra[] = [],
): Trace {
  return run(input, context, new Faults(), extras, meta);
}

const variantKey = (v: Variant) => JSON.stringify([v.sku, v.size ?? null, v.color ?? null]);

/** Sorts variants and drops repeats, keeping the last entry for each. */
function sortedVariants<T>(entries: Iterable<readonly [Variant, T]>): [Variant, T][] {
  const map = new Map<string, [Variant, T]>();
  for (const [v, x] of entries) map.set(variantKey(v), [v, x]);
  return [...map.values()].sort(([a], [b]) => compareVariants(a, b));
}

function project(input: EvalInput, faults: Faults): JsonObject {
  const c = input.context;
  let size = true;
  let color = true;
  try {
    const a = attributes(input.mandate);
    size = a.size !== undefined;
    color = a.color !== undefined;
  } catch {
    // An unreadable mandate denies anyway; its error is recorded when the entity is built.
  }
  const projected = (v: Variant): Variant => {
    const out: Variant = { sku: v.sku };
    if (size && v.size !== undefined) out.size = v.size;
    if (color && v.color !== undefined) out.color = v.color;
    return out;
  };
  const cartVariants = sortedVariants(c.variants.map((v) => [v, null] as const)).map(([v]) => v);
  const variants = sortedVariants(cartVariants.map((v) => [projected(v), null] as const));
  const quantities = sortedVariants(c.quantities);

  const canonical =
    quantities.length === cartVariants.length &&
    quantities.every(([v], n) => compareVariants(v, cartVariants[n] as Variant) === 0) &&
    quantities.every(([, q]) => q >= 1) &&
    Math.max(0, ...quantities.map(([, q]) => q)) === c.max_line_qty;
  const sums = new Map<string, bigint>();
  let overflow = false;
  for (const [v, qty] of quantities) {
    const key = variantKey(projected(v));
    const sum = (sums.get(key) ?? 0n) + BigInt(qty);
    if (sum > 0x7fff_ffff_ffff_ffffn || sum < -0x8000_0000_0000_0000n) overflow = true;
    else sums.set(key, sum);
  }
  let maxLineQty: number | bigint = c.max_line_qty;
  if (canonical && !overflow) {
    maxLineQty = 0n;
    for (const s of sums.values()) if (s > maxLineQty) maxLineQty = s;
  } else {
    faults.add("quantity", "context.quantities");
  }

  const now = cedarDatetime(input.now);
  return {
    currency: c.currency,
    total_minor: c.total_minor,
    merchant: c.merchant,
    categories: sortedSet(c.categories),
    variants: variants.map(([v]) => variantJson(v)),
    max_line_qty: safe(maxLineQty),
    max_unit_minor: c.max_unit_minor,
    return_days: c.return_days,
    returns_free: c.returns_free,
    now: now === undefined ? null : datetimeJson(now),
  };
}

/** Checks the context against the `checkout` context type and rejects empty carts. */
function checkContext(context: Json, faults: Faults): void {
  if (!isObject(context)) {
    faults.add(undefined, "context.invalid");
    return;
  }
  for (const [attr, kind] of CONTEXT) {
    if (!Object.hasOwn(context, attr)) faults.add(undefined, `context.missing:${attr}`);
    else if (!accepts(kind, context[attr])) faults.add(undefined, `context.type:${attr}`);
  }
  for (const key of Object.keys(context)) {
    if (!CONTEXT_ATTRS.has(key)) faults.add(undefined, `context.extra:${key}`);
  }
  const { variants, categories } = context;
  if (Array.isArray(variants) && variants.length === 0) {
    faults.add(undefined, "context.empty:variants");
  }
  if (Array.isArray(categories) && (categories.length === 0 || categories.includes(""))) {
    faults.add(undefined, "context.empty:categories");
  }
}

/** A policy set with extras added, as Cedar holds it preparsed. */
interface ExtrasSet {
  hash: string;
  compiled: [string, string][];
  set: ReadonlyMap<string, PolicyInfo>;
  setId: string;
  error?: string;
}

/** The last extras set, which is the one Cedar holds as [`EXTRAS_SET`]. */
let lastExtras: ExtrasSet | undefined;

/**
 * Compiles the extras and preparses them with the bundled policies, reusing the last set when
 * the extras are the same, as they are for every cart a user's agent proposes.
 */
function withExtras(extras: readonly Extra[], hash: string): ExtrasSet {
  if (lastExtras?.hash === hash) return lastExtras;
  const base = policies();
  let out: ExtrasSet;
  try {
    const compiled = compile(extras);
    const staticPolicies: Record<string, string> = {};
    for (const [id, info] of base) staticPolicies[id] = info.text;
    for (const { id, text } of compiled) staticPolicies[id] = text;
    out =
      preparsePolicySet(EXTRAS_SET, { staticPolicies }).type === "success"
        ? {
            hash,
            compiled: compiled.map(({ id, text }) => [id, text]),
            set: new Map([
              ...base,
              ...compiled.map(({ id, text, json }) => [id, policyInfo(text, json)] as const),
            ]),
            setId: EXTRAS_SET,
          }
        : { hash, compiled: [], set: base, setId: BASE_SET, error: "extras.invalid:cedar" };
  } catch (e) {
    if (!(e instanceof ExtrasError)) throw e;
    const error = e.reason === "too_many" ? "extras.invalid:too_many" : `extras.invalid:${e.index}`;
    out = { hash, compiled: [], set: base, setId: BASE_SET, error };
  }
  lastExtras = out;
  return out;
}

function run(
  input: Omit<EvalInput, "context">,
  rawContext: unknown,
  faults: Faults,
  extras: readonly Extra[],
  meta: EngineMeta,
): Trace {
  const base = policies();
  const hash = extras.length > 0 ? extrasHash(extras) : undefined;
  const { compiled, set, setId, error } =
    hash === undefined ? { compiled: [], set: base, setId: BASE_SET } : withExtras(extras, hash);
  if (error !== undefined) faults.add(undefined, error);

  const context = safe(rawContext);
  const before = faults.errors.length;
  checkContext(context, faults);
  const contextOk = faults.errors.length === before;

  let entity: MandateEntity | undefined;
  try {
    entity = mandateEntity(input.mandate, input.budgetLeftMinor);
  } catch (e) {
    if (!(e instanceof EntityError)) throw e;
    faults.add(undefined, `entity.invalid:${e.field}`);
  }
  let response: Response | undefined;
  if (entity && contextOk) {
    const answer = statefulIsAuthorized({
      principal: { type: AGENT_TYPE, id: input.agent },
      action: ACTION,
      resource: entity.uid,
      context: context as CedarContext,
      preparsedSchemaName: SCHEMA_NAME,
      validateRequest: true,
      preparsedPolicySetId: setId,
      entities: [entity],
    });
    if (answer.type === "success") response = answer.response;
    else entity = diagnose(entity, context as CedarContext, faults);
  } else if (entity && !buildsInCedar(entity)) {
    faults.add(undefined, "entity.invalid:cedar");
    entity = undefined;
  }
  const bounds = entity ? safe(entity.attrs) : undefined;

  const fired: string[] = [];
  let allowed = false;
  if (response) {
    allowed = response.decision === "allow";
    for (const id of response.diagnostics.reason) {
      if (set.get(id)?.effect === "forbid") fired.push(id);
    }
    for (const e of response.diagnostics.errors)
      faults.add(e.policyId, `policy.error:${e.policyId}`);
  }
  fired.sort(compareStrings);
  const errors = sortedSet(faults.errors);
  const decision = allowed && fired.length === 0 && errors.length === 0 ? "allow" : "deny";

  const principal: Json = { __entity: { type: AGENT_TYPE, id: input.agent } };
  const rows: [string, Json | undefined, Json | undefined, boolean][] = [];
  for (const id of base.keys()) {
    if (id === "base") continue;
    const b = BINDINGS[id];
    if (b === undefined) {
      rows.push([id, undefined, undefined, false]);
      continue;
    }
    const observed = id === "agent" ? principal : pick(context, b[0]);
    rows.push([id, observed, bounds === undefined ? undefined : pick(bounds, b[1]), false]);
  }
  compiled.forEach(([id], n) => {
    const [attr, literal] = binding(extras[n] as Extra);
    rows.push([id, pick(context, [attr]), literal, true]);
  });

  const fields = rows.flatMap(([id, observed, bound, extra]): FieldTrace[] => {
    const policy = set.get(id);
    if (policy === undefined) return [];
    // Extras are always green, so evidence is not shown for them.
    const evidence =
      !extra && Object.hasOwn(input.evidence, policy.field)
        ? [...(input.evidence[policy.field] as readonly string[])]
        : [];
    const proven = evidence.some((e) => e.startsWith("ucp:") || e.startsWith("zktls:"));
    const f: FieldTrace = {
      id,
      field: policy.field,
      color: proven ? "green" : policy.color,
      pass: response !== undefined && !fired.includes(id) && !faults.policies.has(id),
      evidence,
    };
    if (observed !== undefined) f.observed = observed;
    if (bound !== undefined) f.bound = bound;
    return [f];
  });

  const trace: Trace = {
    v: TRACE_VERSION,
    engine: {
      cedar_policy: meta.cedar_policy,
      lang: meta.lang,
      symcc: meta.symcc,
      cvc5: meta.cvc5,
      oci_digest: meta.oci_digest,
      canonicalizer: meta.canonicalizer,
    },
    policy_set_hash: POLICY_SET_HASH,
    schema_hash: SCHEMA_HASH,
    proof_bundle_hash: meta.proof_bundle_hash,
    mandate_hash: `0x${hex(input.mandateHash)}`,
    cart_hash: `sha256:${hex(input.cartHash)}`,
    context,
    decision,
    fired,
    fields,
    errors,
    t_tee: teeTime(input.now),
  };
  if (hash !== undefined) trace.extras_hash = hash;
  return trace;
}

/**
 * Cedar evaluates the entity's attributes when it builds the entity, so an attribute it rejects
 * is `entity.invalid:cedar` and leaves no bounds to show.
 */
const buildsInCedar = (entity: MandateEntity) =>
  checkParseEntities({ entities: [entity] }).type === "success";

/**
 * Records why Cedar refused the request, checking in the Rust engine's order: the entity, then
 * the context against the schema, then the entities against it. Returns the entity if it builds.
 */
function diagnose(
  entity: MandateEntity,
  context: CedarContext,
  faults: Faults,
): MandateEntity | undefined {
  if (!buildsInCedar(entity)) {
    faults.add(undefined, "entity.invalid:cedar");
    return undefined;
  }
  if (checkParseContext({ context, schema: SCHEMA_SRC, action: ACTION }).type !== "success") {
    faults.add(undefined, "context.invalid");
  } else if (checkParseEntities({ entities: [entity], schema: SCHEMA_SRC }).type !== "success") {
    faults.add(undefined, "entity.invalid:cedar");
  } else {
    faults.add(undefined, "request.invalid");
  }
  return entity;
}

function pick(source: Json, keys: readonly string[]): Json | undefined {
  if (keys.length === 0) return undefined;
  if (keys.length === 1) {
    const v = get(source, keys[0] as string);
    return v === undefined ? undefined : (v as Json);
  }
  const out: JsonObject = {};
  for (const k of keys) {
    const v = get(source, k);
    if (v !== undefined) out[k] = v as Json;
  }
  return out;
}
