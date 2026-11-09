export type CheckStatus = "pass" | "fail" | "undisclosed" | "pending" | "absent" | "unreachable";

export type CheckId =
  | "bundle.format"
  | "leaf.view"
  | "tee.countersign"
  | "log.policy"
  | "log.inclusion"
  | "log.witnesses"
  | "anchor.consistency"
  | "timestamps"
  | "zk.c1"
  | "evidence.manifest"
  | "paypal.ids";

export interface Check {
  id: CheckId;
  /** The verification step it belongs to; 0 for the format and binding checks. */
  step: number;
  status: CheckStatus;
  /** Why the check failed, in English. */
  reason?: string;
  /** RFC 6901 pointers into the bundle that the check read. */
  reads: string[];
  /** The parties a failure points at. */
  blame?: string[];
  ms: number;
  detail?: Record<string, string>;
}

export interface VerifyOptions {
  now?: Date;
}

export type Verdict = "verified" | "verified-unanchored" | "failed" | "incomplete";

export interface Report {
  verdict: Verdict;
  checks: Check[];
}

/** Checks whose `pending` means "not anchored yet" rather than missing evidence. */
const ANCHOR_CHECKS: ReadonlySet<CheckId> = new Set(["anchor.consistency"]);
/** Checks that may be absent or pending without lowering the verdict. */
const OPTIONAL_CHECKS: ReadonlySet<CheckId> = new Set(["zk.c1", "timestamps"]);

/**
 * `failed` if any check failed; `incomplete` if a required check is unreachable or undisclosed;
 * `verified-unanchored` if only the anchor checks are pending; `verified` otherwise.
 */
export function verdictOf(checks: readonly Check[]): Verdict {
  if (checks.some((c) => c.status === "fail")) return "failed";
  const required = checks.filter((c) => !OPTIONAL_CHECKS.has(c.id));
  if (
    required.some(
      (c) =>
        c.status === "unreachable" ||
        c.status === "undisclosed" ||
        c.status === "absent" ||
        (c.status === "pending" && !ANCHOR_CHECKS.has(c.id)),
    )
  ) {
    return "incomplete";
  }
  return required.some((c) => c.status === "pending") ? "verified-unanchored" : "verified";
}
