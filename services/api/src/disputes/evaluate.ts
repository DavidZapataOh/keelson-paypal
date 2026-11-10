import { createChainReader, verifyAlibi } from "@keelson/alibi/verify";
import { deploymentsFor, mandateViolationCourtAbi } from "@keelson/chain";
import { type CurrencyCode, fromPayPalValue } from "@keelson/core";
import {
  alibis,
  and,
  type Db,
  disputes,
  eq,
  isNotNull,
  ne,
  purchases,
  transition,
  verdicts,
} from "@keelson/db";
import { LOG_HOST, LOG_ORIGINS } from "@keelson/log";
import { getDispute, listTrackers } from "@keelson/paypal";
import type { Logger } from "pino";
import type { RedisClientType } from "redis";
import { ulid } from "ulid";
import type { Hex, PublicClient } from "viem";
import { type AnchorDeps, reanchorAlibi, recordAnchor } from "../alibi/anchors.ts";
import { loadAlibi } from "../alibi/issue.ts";
import type { LogConfig } from "../log/append.ts";
import { payeeFor, settlementOf } from "../merchants.ts";
import { call, type PayPalDeps } from "../paypal.ts";
import type { TeeConfig } from "../tee/signers.ts";
import { verdict2of2 } from "../tee/verdict.ts";
import { disputeFacts } from "./facts.ts";

export interface EvaluateDeps {
  db: Db;
  kv: RedisClientType;
  log: Logger;
  paypal: PayPalDeps;
  tee: Pick<TeeConfig, "client">;
  chain: { client: PublicClient; logs?: PublicClient };
  /** The RPC the Alibi's chain checks read. */
  rpcUrl?: string | undefined;
  tlog: LogConfig;
}

export type Evaluation =
  | { status: "attributed"; disputeId: string; ruleId: number; liable: number; digest: Hex }
  | { status: "resolved" | "unknown"; disputeId: string };

/** PYUSD base units per US cent. */
const PYUSD_PER_MINOR = 10_000n;
/** How long a verdict can be settled after it is signed. */
const VERDICT_TTL_S = 3_600;
const ANCHOR_TIMEOUT_MS = 150_000;
const ANCHOR_VISIBLE_MS = 30_000;

/**
 * Has the log anchor its latest witnessed checkpoint now, through its private listener; resolves
 * to the anchor's transaction, absent when the checkpoint was already anchored.
 */
async function anchorNow(tlog: LogConfig, chainId: number): Promise<Hex | undefined> {
  const origin = LOG_ORIGINS[chainId];
  if (!origin) throw new Error(`chain ${chainId} has no log origin`);
  const res = await fetch(
    `${tlog.url.replace(/\/$/, "")}/${origin.slice(LOG_HOST.length + 1)}/anchor`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${tlog.token}` },
      signal: AbortSignal.timeout(ANCHOR_TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`anchor now: ${res.status}`);
  return ((await res.json()) as { tx?: Hex | null }).tx ?? undefined;
}

/**
 * Whether `MandateViolationCourt` holds a conviction of the coverage: a C2a proof that its cart
 * violated the mandate, so the purchase has no valid proof of its mandate.
 */
export async function convicted(
  client: PublicClient,
  chainId: number,
  coverageId: Hex,
): Promise<boolean> {
  const court = deploymentsFor(chainId).MandateViolationCourt;
  if (!court) return false;
  if (client.chain?.id !== chainId) throw new Error(`the chain client is not on chain ${chainId}`);
  const [code] = await client.readContract({
    address: court,
    abi: mandateViolationCourtAbi,
    functionName: "violations",
    args: [coverageId],
  });
  return code !== 0;
}

/**
 * Attributes one stored dispute and stores the `Verdict` both legs signed. Run as often as it is
 * started: a dispute with a verdict answers that verdict, and every write is conditional.
 * A failed read or signature throws, so the run is retried; nothing defaults to a fact.
 */
export async function evaluateDispute(deps: EvaluateDeps, disputeId: string): Promise<Evaluation> {
  const { db } = deps;
  const [row] = await db
    .select({
      state: disputes.state,
      purchase: purchases,
      anchored: isNotNull(alibis.anchor),
      verdict: { ruleId: verdicts.ruleId, liable: verdicts.liable, digest: verdicts.digest },
    })
    .from(disputes)
    .innerJoin(purchases, eq(purchases.id, disputes.purchaseId))
    .leftJoin(alibis, eq(alibis.purchaseId, purchases.id))
    .leftJoin(verdicts, eq(verdicts.disputeId, disputes.id))
    .where(eq(disputes.id, disputeId));
  if (!row) return { status: "unknown", disputeId };
  if (row.verdict?.digest) {
    return {
      status: "attributed",
      disputeId,
      ruleId: row.verdict.ruleId,
      liable: row.verdict.liable,
      digest: `0x${Buffer.from(row.verdict.digest).toString("hex")}`,
    };
  }
  if (row.state === "RESOLVED") return { status: "resolved", disputeId };
  const p = row.purchase;
  const chainId = p.chainId ?? 421614;
  if (!p.paypalCaptureId || !p.paypalOrderId || !p.countersign) {
    throw new Error(`purchase ${p.id} was not captured under a countersign`);
  }

  // The leaf must be under an anchored checkpoint before its proof is judged.
  if (!row.anchored) {
    const anchorDeps: AnchorDeps = { ...deps, tlog: deps.tlog };
    if ((await reanchorAlibi(anchorDeps, p.id)) === "not_covered") {
      const tx = await anchorNow(deps.tlog, chainId);
      if (tx) await recordAnchor(deps, chainId, tx);
      // An anchor sent before this one reaches the scan of the chain's logs some blocks after its
      // receipt; waiting here is cheaper than a retry.
      const until = Date.now() + ANCHOR_VISIBLE_MS;
      while ((await reanchorAlibi(anchorDeps, p.id)) === "not_covered") {
        if (Date.now() > until)
          throw new Error(`no anchor covers the leaf of purchase ${p.id} yet`);
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
  }
  const bundle = await loadAlibi(db, p.id);
  if (!bundle?.anchor) throw new Error(`purchase ${p.id} has no anchored alibi`);

  const { payments, orders } = deps.paypal.paypal;
  const cs = p.countersign;
  const [dispute, report, capture, order, trackers, sameCart, settlement, violated] =
    await Promise.all([
      getDispute(deps.paypal.paypal.fetch, disputeId),
      verifyAlibi(bundle, {
        chain: createChainReader(deps.rpcUrl ? { rpc: { [chainId]: deps.rpcUrl } } : {}),
      }),
      call(payments.getCapturedPayment({ captureId: p.paypalCaptureId })),
      call(orders.getOrder({ id: p.paypalOrderId })),
      listTrackers(deps.paypal.paypal.fetch, p.paypalCaptureId),
      db
        .select({ id: purchases.id })
        .from(purchases)
        .where(
          and(
            eq(purchases.mandateId, p.mandateId),
            eq(purchases.cartHash, p.cartHash),
            ne(purchases.id, p.id),
            isNotNull(purchases.paypalCaptureId),
          ),
        )
        .limit(1),
      settlementOf(db, p.merchantId),
      convicted(deps.chain.client, chainId, cs.requestId as Hex),
    ]);
  if (dispute.status === "RESOLVED") return { status: "resolved", disputeId };
  const { facts, failedFields } = disputeFacts({
    reads: { dispute, capture, order, trackers },
    bundle,
    verified: report.verdict === "verified" && !violated,
    sameCartCountersigned: sameCart.length > 0,
  });

  // The rail is fixed here: the legs sign the payee it implies.
  const { rail } = settlement;
  const payee = payeeFor(p.merchantId, rail);
  const disputed = dispute.dispute_amount
    ? fromPayPalValue(
        dispute.dispute_amount.currency_code as CurrencyCode,
        dispute.dispute_amount.value,
      ).minor
    : p.amountMinor;
  // biome-ignore lint/complexity/useMathMinMax: amounts are bigints.
  const minor = disputed < p.amountMinor ? disputed : p.amountMinor;
  const issuedAt = Math.floor(Date.now() / 1000);
  const signed = await verdict2of2(deps, {
    facts: facts as unknown as Record<string, string | boolean>,
    input: {
      paypal_dispute_id: disputeId,
      coverage_id: cs.requestId as Hex,
      agent_id: cs.agentId as string,
      payee,
      amount: String(minor * PYUSD_PER_MINOR),
      failed_fields: failedFields,
      evidence_hash: cs.evidenceRoot as Hex,
      checkpoint_root: bundle.anchor.anchored_root as Hex,
      issued_at: issuedAt,
      deadline: issuedAt + VERDICT_TTL_S,
    },
    chain_id: chainId,
  });

  const ruleId = Number(signed.message.ruleId);
  const liable = Number(signed.message.liable);
  const inserted = await db.transaction(async (tx) => {
    const stored = await tx
      .insert(verdicts)
      .values({
        id: ulid(),
        disputeId,
        liable,
        ruleId,
        amountMinor: minor,
        currency: p.currency,
        payee,
        rail,
        digest: Buffer.from(signed.digest.slice(2), "hex"),
        chainId: signed.chainId,
        message: signed.message,
        signatures: signed.signatures,
        facts,
      })
      .onConflictDoNothing({ target: verdicts.disputeId })
      .returning({ id: verdicts.id });
    if (stored.length === 0) return false;
    await transition(tx, "disputes", disputeId, "OPEN", "ATTRIBUTED", { ruleId, liable });
    await transition(tx, "purchases", p.id, "DISPUTED", "ATTRIBUTED");
    return true;
  });
  // A concurrent run stored its verdict first: that one stands.
  if (!inserted) return evaluateDispute(deps, disputeId);
  deps.log.info({ disputeId, purchaseId: p.id, ruleId, liable }, "dispute attributed");
  return { status: "attributed", disputeId, ruleId, liable, digest: signed.digest };
}
