import {
  keelsonBondVaultAbi,
  keelsonReserveAbi,
  payWarrantyArgs,
  slashArgs,
  type Verdict,
} from "@keelson/chain";
import type { CurrencyCode } from "@keelson/core";
import {
  and,
  type Db,
  disputes,
  eq,
  inArray,
  isNull,
  lte,
  notInArray,
  or,
  purchases,
  sql,
  transition,
  verdicts,
} from "@keelson/db";
import {
  createPayout,
  getDispute,
  getPayoutBatch,
  ids,
  PayPalError,
  verdictRefund,
} from "@keelson/paypal";
import { type Relayer, RelayerError, type TxRecord } from "@keelson/relayer";
import type { Logger } from "pino";
import { type Hex, hexToBytes, type PublicClient, parseEventLogs } from "viem";
import { settlementOf } from "../merchants.ts";
import { call, type PayPalDeps } from "../paypal.ts";

export interface SettleDeps {
  db: Db;
  log: Logger;
  /** Refunds and payouts; without it only the chain settles. */
  paypal?: PayPalDeps | undefined;
  /** Sends `slash`, `payWarranty` and `executeSlash`; without it nothing moves on chain. */
  relayer?: Relayer | undefined;
  /** Reads the receipts of the relayed calls. */
  chain: { client: PublicClient };
}

export type Settlement =
  | { status: "settled"; disputeId: string; outcome: "paid" | "claimable"; txHash: Hex | null }
  | { status: "pending"; disputeId: string; waiting: "veto" | "payout" | "chain" }
  | { status: "failed"; disputeId: string; failure: string }
  | { status: "none" | "unattributed"; disputeId: string };

const OPERATOR = 1;
const KEELSON = 2;
const CHAIN_ID = 421614;
const PENDING_WAIT_MS = 8_000;
/** Contract refusals no retry can change: the verdict cannot be settled on chain. */
const FINAL = new Set([
  "AlreadySettled",
  "CoverageNotActive",
  "ExceedsCoverage",
  "Expired",
  "InsufficientReserve",
  "InvalidVerdictSignature",
  "NotAnchored",
  "NotKeelsonLiable",
  "NotOperatorLiable",
  "UnknownCoverage",
  "WarrantyWindowClosed",
  "ZeroAmount",
]);
/** Payout item statuses PayPal does not move on from without the merchant. */
const PAYOUT_FAILED = new Set(["FAILED", "RETURNED", "REFUNDED", "REVERSED", "BLOCKED"]);
const PAYOUT_DONE = new Set(["SUCCESS", ...PAYOUT_FAILED]);
const SETTLES = { [OPERATOR]: "SLASHED", [KEELSON]: "WARRANTY_PAID" } as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Row = typeof verdicts.$inferSelect & {
  purchaseId: string;
  merchantId: string;
  captureId: string | null;
  anchoredSize: bigint | null;
};

/** The stored `Verdict` message as the contracts take it. */
function verdictOf(m: Record<string, string>): Verdict {
  return {
    disputeId: m.disputeId as Hex,
    coverageId: m.coverageId as Hex,
    agentId: BigInt(m.agentId as string),
    payee: m.payee as Hex,
    amount: BigInt(m.amount as string),
    ruleId: Number(m.ruleId),
    liable: Number(m.liable),
    fieldId: Number(m.fieldId),
    evidenceHash: m.evidenceHash as Hex,
    inputsHash: m.inputsHash as Hex,
    policySetHash: m.policySetHash as Hex,
    checkpointRoot: m.checkpointRoot as Hex,
    issuedAt: Number(m.issuedAt),
    deadline: Number(m.deadline),
  };
}

/** The legs' signatures in the order the verifier takes them: TDX, then Nitro. */
function signaturesOf(row: Row): { tdx: Hex; nitro: Hex | null } {
  const by = (tee: number) => row.signatures.find((s) => s.tee === tee)?.signature as Hex;
  const tdx = by(1);
  if (!tdx) throw new Error(`verdict of ${row.disputeId} has no TDX signature`);
  return { tdx, nitro: by(2) ?? null };
}

const digestOf = (row: Row) => new Uint8Array(row.digest);

/**
 * Moves the money a stored verdict assigns. The operator or Keelson at fault refunds the buyer
 * (Payments v2, under the verdict's `ksv1.` reference, while the dispute is an inquiry) and pays
 * the verdict's payee on chain: the operator's bond through `slash`, Keelson's reserve through
 * `payWarranty`. When the merchant settles through PayPal the payee is Keelson's treasury, which
 * then pays the merchant a PayPal Payout. Run as often as it is started: every call is keyed by the
 * verdict, every write conditional. A failure worth retrying throws.
 */
export async function settleDispute(deps: SettleDeps, disputeId: string): Promise<Settlement> {
  let row = await load(deps.db, disputeId);
  if (!row) return { status: "unattributed", disputeId };
  if (row.liable !== OPERATOR && row.liable !== KEELSON) {
    await transition(
      deps.db,
      "purchases",
      row.purchaseId,
      "ATTRIBUTED",
      row.liable === 3 ? "MERCHANT_LIABLE" : "DEFENDED",
    );
    return { status: "none", disputeId };
  }
  if (row.outcome === "failed") {
    return { status: "failed", disputeId, failure: row.failure ?? "unknown" };
  }

  if (!row.refundId && deps.paypal && row.captureId) await refundBuyer(deps, deps.paypal, row);

  if (row.outcome === null || row.outcome === "queued") {
    if (!deps.relayer) return { status: "pending", disputeId, waiting: "chain" };
    const moved = await onChain(deps, deps.relayer, row);
    if (moved) return moved;
    row = (await load(deps.db, disputeId)) as Row;
  }
  if (row.outcome === "failed") {
    return { status: "failed", disputeId, failure: row.failure ?? "unknown" };
  }

  if (row.rail === "paypal" && row.outcome === "paid") {
    if (!deps.paypal) return { status: "pending", disputeId, waiting: "payout" };
    const status =
      row.payoutStatus && PAYOUT_DONE.has(row.payoutStatus)
        ? row.payoutStatus
        : await payout(deps, deps.paypal, row);
    // The treasury holds the merchant's money until the merchant names an account PayPal pays.
    if (PAYOUT_FAILED.has(status))
      return { status: "failed", disputeId, failure: `payout ${status}` };
    if (status !== "SUCCESS") return { status: "pending", disputeId, waiting: "payout" };
  }
  await transition(
    deps.db,
    "purchases",
    row.purchaseId,
    "ATTRIBUTED",
    SETTLES[row.liable as 1 | 2],
  );
  const txHash = row.txHash ? (`0x${Buffer.from(row.txHash).toString("hex")}` as Hex) : null;
  return { status: "settled", disputeId, outcome: row.outcome as "paid" | "claimable", txHash };
}

async function load(db: Db, disputeId: string): Promise<Row | undefined> {
  const [row] = await db
    .select({
      verdict: verdicts,
      purchaseId: purchases.id,
      merchantId: purchases.merchantId,
      captureId: purchases.paypalCaptureId,
      anchoredSize: purchases.anchoredSize,
    })
    .from(verdicts)
    .innerJoin(disputes, eq(disputes.id, verdicts.disputeId))
    .innerJoin(purchases, eq(purchases.id, disputes.purchaseId))
    .where(eq(verdicts.disputeId, disputeId));
  if (!row) return undefined;
  const { verdict, ...purchase } = row;
  return { ...verdict, ...purchase };
}

/**
 * Refunds the whole capture while the dispute is an inquiry. In a chargeback the card network
 * already returned the money and PayPal's `accept-claim` settles it.
 */
async function refundBuyer(deps: SettleDeps, paypal: PayPalDeps, row: Row): Promise<void> {
  const dispute = await getDispute(paypal.paypal.fetch, row.disputeId);
  if (dispute.status === "RESOLVED" || dispute.dispute_life_cycle_stage !== "INQUIRY") return;
  const rule = `R${String(row.ruleId).padStart(2, "0")}`;
  const req = verdictRefund(
    row.id,
    digestOf(row),
    `Refunded by Keelson: dispute ${row.disputeId} attributed under ${rule}.`,
  );
  try {
    const refund = await call(
      paypal.paypal.payments.refundCapturedPayment({ captureId: row.captureId as string, ...req }),
    );
    await deps.db
      .update(verdicts)
      .set({ refundId: refund.id ?? null })
      .where(and(eq(verdicts.id, row.id), isNull(verdicts.refundId)));
    row.refundId = refund.id ?? null;
    deps.log.info({ disputeId: row.disputeId, refundId: refund.id }, "buyer refunded");
  } catch (err) {
    // Refunded already, by PayPal's own resolution or by hand: nothing is left to return.
    if (
      err instanceof PayPalError &&
      err.details.some((d) => d.issue === "CAPTURE_FULLY_REFUNDED")
    ) {
      return;
    }
    throw err;
  }
}

/** Sends the verdict's call, or executes its queued slash once the veto window closed. */
async function onChain(
  deps: SettleDeps,
  relayer: Relayer,
  row: Row,
): Promise<Settlement | undefined> {
  const v = verdictOf(row.message);
  const id = v.disputeId;
  if (row.outcome === "queued") {
    if (!row.readyAt || row.readyAt.getTime() > Date.now()) {
      return { status: "pending", disputeId: row.disputeId, waiting: "veto" };
    }
    return record(deps, row, () =>
      relayer.submit({
        chainId: CHAIN_ID,
        contract: "KeelsonBondVault",
        functionName: "executeSlash",
        args: [id],
        key: `KeelsonBondVault.executeSlash:${id}`,
      }),
    );
  }
  if (row.anchoredSize === null) throw new Error(`purchase ${row.purchaseId} is not anchored`);
  const sigs = signaturesOf(row);
  return record(deps, row, () =>
    row.liable === OPERATOR
      ? relayer.submit({
          chainId: CHAIN_ID,
          contract: "KeelsonBondVault",
          functionName: "slash",
          args: slashArgs(v, row.anchoredSize as bigint, sigs.nitro ? "2of2" : "degraded", sigs),
          key: `KeelsonBondVault.slash:${id}`,
        })
      : relayer.submit({
          chainId: CHAIN_ID,
          contract: "KeelsonReserve",
          functionName: "payWarranty",
          args: payWarrantyArgs(v, row.anchoredSize as bigint, {
            tdx: sigs.tdx,
            nitro: sigs.nitro ?? "0x",
          }),
          key: `KeelsonReserve.payWarranty:${id}`,
        }),
  );
}

/** Submits, waits for the receipt and stores what the contract's events say happened. */
async function record(
  deps: SettleDeps,
  row: Row,
  submit: () => Promise<TxRecord>,
): Promise<Settlement | undefined> {
  let tx: TxRecord | undefined;
  try {
    tx = await submit();
    const deadline = Date.now() + PENDING_WAIT_MS;
    while (tx?.status === "pending" && Date.now() < deadline) {
      await sleep(250);
      tx = await deps.relayer?.getById(tx.id);
    }
  } catch (err) {
    const name =
      err instanceof RelayerError
        ? (err.detail as { error?: { name?: string } } | undefined)?.error?.name
        : undefined;
    if (name && FINAL.has(name)) return fail(deps, row, name);
    throw err;
  }
  if (tx?.status === "reverted" && tx.error && FINAL.has(tx.error.name)) {
    return fail(deps, row, tx.error.name);
  }
  if (tx?.status !== "confirmed" || !tx.hash) {
    throw new Error(`settlement of ${row.disputeId}: transaction ${tx?.status ?? "missing"}`);
  }
  const receipt = await deps.chain.client.getTransactionReceipt({ hash: tx.hash });
  const events = parseEventLogs({
    abi: [...keelsonBondVaultAbi, ...keelsonReserveAbi],
    logs: receipt.logs,
    eventName: ["Slashed", "SlashQueued", "WarrantyPaid", "PayoutFailed"],
  }).filter((e) => e.args.disputeId === row.message.disputeId);
  const has = (name: string) => events.some((e) => e.eventName === name);
  const queued = events.find((e) => e.eventName === "SlashQueued");
  const outcome = has("PayoutFailed")
    ? "claimable"
    : has("Slashed") || has("WarrantyPaid")
      ? "paid"
      : queued
        ? "queued"
        : null;
  if (!outcome) throw new Error(`${tx.hash} settled nothing for ${row.disputeId}`);
  const readyAt =
    queued?.eventName === "SlashQueued" ? new Date(Number(queued.args.readyAt) * 1000) : null;
  await deps.db
    .update(verdicts)
    .set({
      outcome,
      txId: tx.id,
      txHash: Buffer.from(hexToBytes(tx.hash)),
      readyAt,
      ...(outcome === "queued" ? {} : { settledAt: new Date() }),
    })
    .where(eq(verdicts.id, row.id));
  deps.log.info(
    { disputeId: row.disputeId, outcome, txHash: tx.hash, latencyMs: tx.latencyMs },
    "dispute settled on chain",
  );
  return outcome === "queued"
    ? { status: "pending", disputeId: row.disputeId, waiting: "veto" }
    : undefined;
}

async function fail(deps: SettleDeps, row: Row, failure: string): Promise<Settlement> {
  await deps.db.update(verdicts).set({ outcome: "failed", failure }).where(eq(verdicts.id, row.id));
  deps.log.error({ disputeId: row.disputeId, failure }, "dispute cannot be settled on chain");
  return { status: "failed", disputeId: row.disputeId, failure };
}

/**
 * Pays the merchant in USD what the treasury received in PYUSD, once per verdict: the batch id
 * and the request id are the verdict's reference, so PayPal refuses a second batch.
 */
async function payout(deps: SettleDeps, paypal: PayPalDeps, row: Row): Promise<string> {
  const { fetch } = paypal.paypal;
  let batchId = row.payoutBatchId;
  if (!batchId) {
    const { paypalReceiver } = await settlementOf(deps.db, row.merchantId);
    if (!paypalReceiver) throw new Error(`merchant ${row.merchantId} has no PayPal receiver`);
    const ref = ids.encodeVerdictRef(row.id, digestOf(row));
    const created = await createPayout(fetch, {
      senderBatchId: `ks-${ref}`,
      items: [
        {
          amount: { currency: row.currency as CurrencyCode, minor: row.amountMinor },
          receiver: paypalReceiver,
          recipientType: paypalReceiver.includes("@") ? "EMAIL" : "PAYPAL_ID",
          senderItemId: ref,
          note: `Keelson settlement of dispute ${row.disputeId}.`,
        },
      ],
    });
    batchId = created.batch_header.payout_batch_id;
    await deps.db.update(verdicts).set({ payoutBatchId: batchId }).where(eq(verdicts.id, row.id));
  }
  const batch = await getPayoutBatch(fetch, batchId);
  const status = batch.items?.[0]?.transaction_status ?? batch.batch_header.batch_status;
  await deps.db.update(verdicts).set({ payoutStatus: status }).where(eq(verdicts.id, row.id));
  deps.log.info({ disputeId: row.disputeId, batchId, status }, "settlement payout");
  return status;
}

/**
 * Settles again the verdicts that wait: queued slashes whose veto window closed, payouts PayPal
 * has not finished, and verdicts whose workflow run did not get to settle them. Returns how many
 * were tried.
 */
export async function resumeSettlements(deps: SettleDeps): Promise<number> {
  const waiting = await deps.db
    .select({ disputeId: verdicts.disputeId })
    .from(verdicts)
    .where(
      and(
        inArray(verdicts.liable, [OPERATOR, KEELSON]),
        or(
          and(eq(verdicts.outcome, "queued"), lte(verdicts.readyAt, sql`now()`)),
          and(
            eq(verdicts.rail, "paypal"),
            eq(verdicts.outcome, "paid"),
            or(isNull(verdicts.payoutStatus), notInArray(verdicts.payoutStatus, [...PAYOUT_DONE])),
          ),
          and(isNull(verdicts.outcome), lte(verdicts.createdAt, sql`now() - interval '1 minute'`)),
        ),
      ),
    )
    .limit(20);
  for (const { disputeId } of waiting) {
    await settleDispute(deps, disputeId).catch((err: unknown) =>
      deps.log.warn({ err, disputeId }, "settlement retry failed"),
    );
  }
  return waiting.length;
}
