import { LEAF_PREFIX, receiptKeyMap } from "@keelson/log";
import { type EarStatus, earClaims } from "@keelson/scitt";
import { fromBase64 } from "../b64.ts";
import type { AlibiBundle, AlibiReceipt, AnyAlibi } from "../schema.ts";
import { type Context, runCheck } from "./check.ts";
import { anchor } from "./checks/anchor.ts";
import { nitro, tdx } from "./checks/attestation.ts";
import { card } from "./checks/card.ts";
import { cardStatements } from "./checks/card-statements.ts";
import { anchorRoot, anchorTx, chainIdOf, queryOf, registry } from "./checks/chain.ts";
import { checkout } from "./checks/checkout.ts";
import { cmw } from "./checks/cmw.ts";
import { conversion } from "./checks/conversion.ts";
import { countersign } from "./checks/countersign.ts";
import { evidence } from "./checks/evidence.ts";
import { format } from "./checks/format.ts";
import { leaf } from "./checks/leaf.ts";
import { inclusion, policy, witnesses } from "./checks/log.ts";
import { challenge, credentials, passkey } from "./checks/mandate.ts";
import { paypal } from "./checks/paypal.ts";
import { replay } from "./checks/policy.ts";
import { qr } from "./checks/qr.ts";
import { receipt } from "./checks/receipt.ts";
import { statement } from "./checks/statement.ts";
import { timestamps, zk, zkC3 } from "./checks/timestamps.ts";
import { isBundle } from "./checks/util.ts";
import { webFact } from "./checks/web-fact.ts";
import { diffPointers, expand, reads, UNBOUND, valueAt } from "./expand.ts";
import { fieldsOf } from "./fields.ts";
import { type Check, type Report, type VerifyOptions, verdictOf } from "./report.ts";
import { legacyOf, type StatementView, statementView, v2Pointer } from "./view.ts";

export { CATEGORY_LABELS } from "@keelson/mandate";
export { type AmberReading, readAmber } from "./amber.ts";
export {
  type AnonymousPurchaseAnswer,
  type ChainAnswer,
  type ChainQuery,
  type ChainReader,
  type ChainReaderOptions,
  ChainUnreachableError,
  createChainReader,
  type EngineProofAnswer,
  readAnonymousPurchase,
  verifyEngineProof,
} from "./chain.ts";
export { ENGINE_PROGRAM_VKEY } from "./engine-vk.ts";
export { collapse, diffPointers, expand, pointers, UNBOUND, valueAt } from "./expand.ts";
export type { Answers, FieldRow } from "./fields.ts";
export type { Check, CheckId, CheckStatus, Report, Verdict, VerifyOptions } from "./report.ts";
export { verdictOf } from "./report.ts";
export {
  type AnonymousMandateProof,
  type AnonymousPurchase,
  anonymousPurchaseFacts,
  anonymousPurchaseStatement,
  bindAnonymousPurchase,
  c1c3Statement,
  c2bStatement,
  c3Statement,
  RP_ID_HASH,
  registeredUserSetRoot,
  verifyAnonymousMandate,
  verifyAnonymousPurchase,
  verifyC1C3,
  verifyC2b,
  verifyC3,
  type WebFactStatement,
} from "./zk.ts";

const CHECKS = [
  format,
  leaf,
  statement,
  cmw,
  qr,
  challenge,
  passkey,
  credentials,
  tdx,
  nitro,
  countersign,
  registry,
  replay,
  policy,
  inclusion,
  receipt,
  witnesses,
  anchor,
  anchorRoot,
  anchorTx,
  timestamps,
  zk,
  zkC3,
  evidence,
  webFact,
  checkout,
  conversion,
  paypal,
  card,
  cardStatements,
];

/** The one chain read of a verification, started before any offline check runs. */
function chainRead(input: AlibiBundle | AlibiReceipt, opts: VerifyOptions) {
  if (!opts.chain) return null;
  const { chain } = opts;
  const read = (async () => {
    const chainId = chainIdOf(input);
    if (chainId === undefined) throw new Error("the Alibi names no chain");
    return chain.read(chainId, queryOf(input, chainId));
  })();
  read.catch(() => {});
  return read;
}

function modeOf(input: AlibiBundle | AlibiReceipt, view: StatementView | null): Report["mode"] {
  if (view?.parsed?.kind === "purchase") return view.parsed.claims.mode;
  if (isBundle(input)) return input.tee.mode;
  try {
    const text = new TextDecoder().decode(fromBase64(input.leaf));
    const body = JSON.parse(text.slice(LEAF_PREFIX.length)) as { mode?: unknown };
    return body.mode === "degraded" ? "degraded" : "2of2";
  } catch {
    return "degraded";
  }
}

/** The v1-shaped input the checks read, and the statement view of a v2 Alibi. */
function prepare(input: AnyAlibi): {
  legacy: AlibiBundle | AlibiReceipt;
  view: StatementView | null;
} {
  let view: StatementView | null = null;
  try {
    view = statementView(input);
  } catch {
    return { legacy: input as AlibiBundle, view: null };
  }
  try {
    return { legacy: legacyOf(input, view), view };
  } catch {
    // Claims that cannot be read leave only what the log holds; `scitt.statement` says why.
    return {
      legacy: legacyOf({ ...(input as object), attestation: undefined } as never, view),
      view,
    };
  }
}

/**
 * Verifies an Alibi bundle, or the public receipt of one, of either version, against the pinned
 * trust roots and, when `opts.chain` is given, one read of the chain. Each check reports on its
 * own; for a receipt the checks that need a section it does not carry are `undisclosed`.
 */
export async function verifyAlibi(input: AnyAlibi, opts: VerifyOptions = {}): Promise<Report> {
  const started = performance.now();
  const { legacy, view } = prepare(input);
  const ctx: Context = {
    now: opts.now ?? new Date(),
    expect: opts.expect,
    chain: chainRead(legacy, opts),
    view,
    receiptKeys: opts.receiptKeys ?? receiptKeyMap(),
  };
  const changed = opts.original ? diffPointers(expand(opts.original), expand(input)) : [];
  const checks = await Promise.all(
    CHECKS.map(async (c) => {
      const check = await runCheck(c, legacy, ctx);
      if (view) check.reads = [...new Set(check.reads.map(v2Pointer))];
      opts.onCheck?.(check);
      return check;
    }),
  );
  if (changed.length) {
    for (const c of checks) {
      if (c.status === "fail") c.blame = changed.filter((p) => reads(c.reads, p));
    }
  }
  const answer = await ctx.chain?.catch(() => undefined);
  return {
    verdict: verdictOf(checks),
    checks,
    mode: modeOf(legacy, view),
    fields: fieldsOf(legacy),
    unbound: UNBOUND.flatMap((p) => {
      const value = valueAt(input, p);
      return value === undefined ? [] : [{ pointer: p, value }];
    }),
    changed,
    ...(answer ? { rpc: { url: answer.rpc, custom: answer.custom } } : {}),
    ms: performance.now() - started,
  };
}

const AR4SI = { affirming: 2, warning: 32, contraindicated: 96 } as const;

/**
 * The report's attestation results as an EAR claims set (draft-ietf-rats-ear-05), one appraisal per
 * leg: affirming when its attestation verified, contraindicated when it failed, none otherwise.
 */
export function earOf(report: Report, now: Date): Record<string, unknown> {
  const legs = report.mode === "2of2" ? (["tdx", "nitro"] as const) : (["tdx"] as const);
  const appraisal = (c: Check | undefined) => {
    const status: EarStatus =
      c?.status === "pass" ? "affirming" : c?.status === "fail" ? "contraindicated" : "none";
    const v = status === "none" ? undefined : AR4SI[status];
    return {
      status,
      ...(c?.status === "fail" && c.reason ? { details: [c.reason] } : {}),
      ...(v === undefined ? {} : { instanceIdentity: v, executables: v, hardware: v }),
    };
  };
  return earClaims({
    iat: Math.floor(now.getTime() / 1000),
    verifier: { developer: "https://keelson.finance", build: "@keelson/alibi" },
    submods: Object.fromEntries(
      legs.map((l) => [l, appraisal(report.checks.find((c) => c.id === `tee.attestation.${l}`))]),
    ),
  });
}
