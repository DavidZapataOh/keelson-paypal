import type { AlibiBundle, AlibiReceipt } from "../schema.ts";
import type { ChainReader } from "./chain.ts";
import type { FieldRow } from "./fields.ts";

export type CheckStatus = "pass" | "fail" | "undisclosed" | "pending" | "absent" | "unreachable";

export type CheckId =
  | "bundle.format"
  | "leaf.view"
  | "qr.leaf"
  | "mandate.challenge"
  | "mandate.passkey"
  | "mandate.credentials"
  | "tee.attestation.tdx"
  | "tee.attestation.nitro"
  | "tee.countersign"
  | "tee.registry"
  | "policy.replay"
  | "log.policy"
  | "log.inclusion"
  | "log.witnesses"
  | "anchor.consistency"
  | "anchor.root"
  | "anchor.tx"
  | "timestamps"
  | "zk.c1"
  | "zk.c3"
  | "evidence.manifest"
  | "evidence.web_fact"
  | "evidence.checkout"
  | "evidence.conversion"
  | "paypal.ids"
  | "card.authorizations";

export interface Check {
  id: CheckId;
  /** The verification step it belongs to; 0 for the format and binding checks. */
  step: number;
  status: CheckStatus;
  /** Why the check failed, is pending or could not run, in English. */
  reason?: string;
  /** RFC 6901 pointers into the bundle that the check read. */
  reads: string[];
  /** On a failure, the edited pointers (`VerifyOptions.original`) among those it read. */
  blame?: string[];
  ms: number;
  detail?: Record<string, string>;
}

export interface VerifyOptions {
  now?: Date;
  /** Reads the anchor and signer registry; `null` or absent verifies offline (chain checks pending). */
  chain?: ChainReader | null;
  /** What a QR link states about the Alibi; drives `qr.leaf`. */
  expect?: { leafHash: string; anchoredSize?: bigint; chainId?: number };
  /** The Alibi before an edit, so the report says which pointers changed and which checks read them. */
  original?: AlibiBundle | AlibiReceipt;
  /** Called with each check as it completes, before the report. */
  onCheck?: (check: Check) => void;
}

export type Verdict =
  | "verified"
  | "verified-unanchored"
  | "verified-offline"
  | "failed"
  | "incomplete";

/** The reason of a chain check that did not run because no chain reader was given. */
export const OFFLINE = "the chain was not read (offline)";

export interface Report {
  verdict: Verdict;
  checks: Check[];
  mode: "2of2" | "degraded";
  /** The trace's policies, field by field, with who answers for each; empty for a receipt. */
  fields: FieldRow[];
  /** Values no signature or hash covers, shown as the operator's word. */
  unbound: { pointer: string; value: unknown }[];
  /** Pointers whose value differs from `VerifyOptions.original`. */
  changed: string[];
  /** The RPC that answered the chain read, when one did, and whether the caller chose it. */
  rpc?: { url: string; custom: boolean };
  ms: number;
}

/** Checks whose `pending` means "not anchored yet" or "chain not read" rather than missing evidence. */
const ANCHOR_CHECKS: ReadonlySet<CheckId> = new Set([
  "anchor.consistency",
  "anchor.root",
  "anchor.tx",
  "tee.registry",
]);
/** Checks that may be pending without lowering the verdict. */
const OPTIONAL_CHECKS: ReadonlySet<CheckId> = new Set([
  "zk.c1",
  "zk.c3",
  "timestamps",
  "evidence.web_fact",
  "evidence.checkout",
  "evidence.conversion",
]);

/**
 * `failed` if any check failed; `incomplete` if a required check is unreachable, undisclosed or
 * pending; `verified-offline` if the chain was not read, so neither the anchor nor a revocation
 * was checked; `verified-unanchored` if only the anchor checks are pending; `verified` otherwise.
 * A check is `absent` only when the section it reads legitimately does not exist.
 */
export function verdictOf(checks: readonly Check[]): Verdict {
  if (checks.some((c) => c.status === "fail")) return "failed";
  const required = checks.filter((c) => !OPTIONAL_CHECKS.has(c.id));
  if (
    required.some(
      (c) =>
        c.status === "unreachable" ||
        c.status === "undisclosed" ||
        (c.status === "pending" && !ANCHOR_CHECKS.has(c.id)),
    )
  ) {
    return "incomplete";
  }
  const pending = required.filter((c) => c.status === "pending");
  if (pending.some((c) => c.reason === OFFLINE)) return "verified-offline";
  return pending.length ? "verified-unanchored" : "verified";
}
