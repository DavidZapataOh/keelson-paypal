import type { AlibiBundle, AlibiReceipt } from "../schema.ts";
import { runCheck } from "./check.ts";
import { anchor } from "./checks/anchor.ts";
import { nitro, tdx } from "./checks/attestation.ts";
import { countersign } from "./checks/countersign.ts";
import { evidence } from "./checks/evidence.ts";
import { format } from "./checks/format.ts";
import { leaf } from "./checks/leaf.ts";
import { inclusion, policy, witnesses } from "./checks/log.ts";
import { challenge, credentials, passkey } from "./checks/mandate.ts";
import { paypal } from "./checks/paypal.ts";
import { timestamps, zk } from "./checks/timestamps.ts";
import { type Report, type VerifyOptions, verdictOf } from "./report.ts";

export type { Check, CheckId, CheckStatus, Report, Verdict, VerifyOptions } from "./report.ts";
export { verdictOf } from "./report.ts";

const CHECKS = [
  format,
  leaf,
  challenge,
  passkey,
  credentials,
  tdx,
  nitro,
  countersign,
  policy,
  inclusion,
  witnesses,
  anchor,
  timestamps,
  zk,
  evidence,
  paypal,
];

/**
 * Verifies an Alibi bundle, or the public receipt of one, with nothing but the pinned trust roots:
 * no network. Each check reports on its own; for a receipt the checks that need a section it
 * does not carry are `undisclosed`.
 */
export async function verifyAlibi(
  input: AlibiBundle | AlibiReceipt,
  opts: VerifyOptions = {},
): Promise<Report> {
  const o = { now: opts.now ?? new Date() };
  const checks = await Promise.all(CHECKS.map((c) => runCheck(c, input, o)));
  return { verdict: verdictOf(checks), checks };
}
