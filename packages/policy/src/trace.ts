import { type Json, jcs } from "@keelson/core";

/** The trace format version. */
export const TRACE_VERSION = "keelson.eval/1";

/** The engine build that produced a trace. */
export interface Engine {
  cedar_policy: string;
  lang: string;
  symcc: string;
  cvc5: string;
  oci_digest: string;
  canonicalizer: string;
}

/** The result of one policy, keyed by its `@id`. */
export interface FieldTrace {
  id: string;
  field: string;
  color: string;
  pass: boolean;
  /** The context value the policy reads, in Cedar JSON form. */
  observed?: Json;
  /** The `Mandate` entity value the policy compares against, in Cedar JSON form. */
  bound?: Json;
  evidence: string[];
}

/** A `keelson.eval/1` trace. */
export interface Trace {
  v: string;
  engine: Engine;
  policy_set_hash: string;
  schema_hash: string;
  proof_bundle_hash: string;
  /** `sha256:<hex>` of the JCS form of the extras, in the order given; absent without extras. */
  extras_hash?: string;
  mandate_hash: string;
  cart_hash: string;
  /** The context passed to Cedar, in Cedar JSON form. */
  context: Json;
  decision: "allow" | "deny";
  /** The ids of the `forbid` policies that determined a deny, sorted. */
  fired: string[];
  fields: FieldTrace[];
  /** Every error met while evaluating, sorted. Any error means deny. */
  errors: string[];
  t_tee: string;
}

/** The trace as RFC 8785 canonical JSON, in UTF-8. */
export function traceJcs(t: Trace): Uint8Array {
  return new TextEncoder().encode(jcs(t as unknown as Json));
}
