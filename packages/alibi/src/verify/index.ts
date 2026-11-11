import { LEAF_PREFIX } from "@keelson/log";
import { fromBase64 } from "../b64.ts";
import type { AlibiBundle, AlibiReceipt } from "../schema.ts";
import { type Context, runCheck } from "./check.ts";
import { anchor } from "./checks/anchor.ts";
import { nitro, tdx } from "./checks/attestation.ts";
import { card } from "./checks/card.ts";
import { anchorRoot, anchorTx, chainIdOf, queryOf, registry } from "./checks/chain.ts";
import { checkout } from "./checks/checkout.ts";
import { countersign } from "./checks/countersign.ts";
import { evidence } from "./checks/evidence.ts";
import { format } from "./checks/format.ts";
import { leaf } from "./checks/leaf.ts";
import { inclusion, policy, witnesses } from "./checks/log.ts";
import { challenge, credentials, passkey } from "./checks/mandate.ts";
import { paypal } from "./checks/paypal.ts";
import { replay } from "./checks/policy.ts";
import { qr } from "./checks/qr.ts";
import { timestamps, zk, zkC3 } from "./checks/timestamps.ts";
import { isBundle } from "./checks/util.ts";
import { webFact } from "./checks/web-fact.ts";
import { diffPointers, expand, reads, UNBOUND, valueAt } from "./expand.ts";
import { fieldsOf } from "./fields.ts";
import { type Report, type VerifyOptions, verdictOf } from "./report.ts";

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
  paypal,
  card,
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

function modeOf(input: AlibiBundle | AlibiReceipt): Report["mode"] {
  if (isBundle(input)) return input.tee.mode;
  try {
    const text = new TextDecoder().decode(fromBase64(input.leaf));
    const body = JSON.parse(text.slice(LEAF_PREFIX.length)) as { mode?: unknown };
    return body.mode === "degraded" ? "degraded" : "2of2";
  } catch {
    return "degraded";
  }
}

/**
 * Verifies an Alibi bundle, or the public receipt of one, against the pinned trust roots and, when
 * `opts.chain` is given, one read of the chain. Each check reports on its own; for a receipt the
 * checks that need a section it does not carry are `undisclosed`.
 */
export async function verifyAlibi(
  input: AlibiBundle | AlibiReceipt,
  opts: VerifyOptions = {},
): Promise<Report> {
  const started = performance.now();
  const ctx: Context = {
    now: opts.now ?? new Date(),
    expect: opts.expect,
    chain: chainRead(input, opts),
  };
  const changed = opts.original ? diffPointers(expand(opts.original), expand(input)) : [];
  const checks = await Promise.all(
    CHECKS.map(async (c) => {
      const check = await runCheck(c, input, ctx);
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
    mode: modeOf(input),
    fields: fieldsOf(input),
    unbound: UNBOUND.flatMap((p) => {
      const value = valueAt(input, p);
      return value === undefined ? [] : [{ pointer: p, value }];
    }),
    changed,
    ...(answer ? { rpc: { url: answer.rpc, custom: answer.custom } } : {}),
    ms: performance.now() - started,
  };
}
