import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  char,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { purchaseState } from "./enums.ts";
import { mandates } from "./mandates.ts";
import { bytea, createdAt, updatedAt } from "./types.ts";

/** A purchase's amber attestation; the salt and the commitment as 0x hex, `unit_minor` decimal. */
export interface StoredAmber {
  url: string;
  sku: string;
  size: string;
  color: string;
  unit_minor: string;
  returns_free: boolean;
  salt: string;
  commitment: string;
}

export const openPurchase = (state: AnyPgColumn) =>
  sql`${state} not in ('SETTLED', 'DENIED', 'FAILED', 'SLASHED', 'WARRANTY_PAID', 'DEFENDED', 'MERCHANT_LIABLE')`;

export const purchases = pgTable(
  "purchases",
  {
    id: char({ length: 26 }).primaryKey(),
    mandateId: char({ length: 26 })
      .notNull()
      .references(() => mandates.id),
    state: purchaseState().notNull().default("PROPOSED"),
    failureReason: text(),
    merchantId: text().notNull(),
    currency: char({ length: 3 }).notNull(),
    amountMinor: bigint({ mode: "bigint" }).notNull(),
    cartHash: bytea().notNull(),
    /** The evidence root the countersign bound; a root binds one purchase only. */
    evidenceRoot: bytea().unique("purchases_evidence_root_unique"),
    countersignDigest: bytea().unique("purchases_countersign_digest_unique"),
    /** The EIP-712 `Countersign` message whose digest is `countersign_digest`, as decimal strings. */
    countersign: jsonb().$type<Record<string, string>>(),
    decision: smallint(),
    /** `degraded` when only the TDX leg signed. Set with the countersign. */
    countersignMode: text(),
    /** Bit 31 is set when the PayPal check failed, beyond `integer`. */
    failedFieldsMask: bigint({ mode: "number" }),
    invoiceId: varchar({ length: 60 }).unique("purchases_invoice_id_unique"),
    paypalCaptureId: text().unique("purchases_paypal_capture_id_unique"),
    logIndex: bigint({ mode: "bigint" }).unique("purchases_log_index_unique"),
    anchoredSize: bigint({ mode: "bigint" }),
    chainId: integer(),
    /** The relayed `recordCountersign` of the purchase's ERC-8004 validation. */
    validationTxId: char({ length: 26 }),
    /** The validation does not apply on this chain: an ALLOW with no coverage to prove the request. */
    validationSkippedAt: timestamp({ withTimezone: true }),
    /** The OAuth client that asked for the countersign; its purchase events go to it too. */
    clientId: text(),
    /** The PayPal order and authorization leg A read for this countersign. */
    paypalOrderId: text(),
    paypalAuthorizationId: text(),
    /**
     * Set when the buyer pays at a real store's own checkout with their PayPal account: the
     * store's origin. Keelson countersigns and logs such a purchase, and neither covers nor
     * captures it.
     */
    liveStore: text(),
    /** The PayPal transaction id of a live purchase, as PayPal reported it to the buyer. */
    paypalTransactionId: text().unique("purchases_paypal_transaction_id_unique"),
    /** The salt of the leaf's `paypal_ref_commit`. */
    paypalRefSalt: bytea(),
    /** The capture's sequence number among the mandate's captures, as its `invoice_id` states it. */
    captureSeq: smallint(),
    /** PayPal's status of the capture. */
    captureStatus: text(),
    /** The relayed `lockCoverage` of the purchase. */
    coverageTxId: text(),
    coverageTxHash: bytea(),
    /** The premium of the coverage, in basis points of its amount, fixed by its first attempt. */
    premiumBps: smallint(),
    /** The purchase is being driven by one process until then. */
    leaseUntil: timestamp({ withTimezone: true }),
    capturedAt: timestamp({ withTimezone: true }),
    /** The `keelson.eval/1` trace both legs signed over; its hash is the countersign's `evalHash`. */
    evalTrace: jsonb(),
    /**
     * Leg A's C1 `mandate_predicate` proof of the ALLOW: `{ proof, public_inputs }`, with the
     * proof of the same witness for recursion when the leg makes one.
     */
    c1Proof: jsonb().$type<{
      proof: string;
      public_inputs: string[];
      recursive_proof?: string | undefined;
    }>(),
    /**
     * C1 composed with the mandate's C3 by recursion (`anonymous_purchase`): UltraHonk for the EVM
     * over C1's public inputs, `mandate_hash` and `user_set_root`.
     */
    c1c3Proof: jsonb().$type<{ proof: string; public_inputs: string[] }>(),
    /**
     * What the legs evaluated besides the mandate, kept so a dispute can run the evaluation again
     * in the SP1 zkVM: the cart, the PayPal unit, the evidence sources, leg A's clock and budget,
     * and the countersign's EIP-712 domain.
     */
    engineInput: jsonb().$type<{
      cart: unknown;
      unit: unknown;
      evidence: Record<string, string[]>;
      now_ms: number;
      budget_left_minor: number;
      chain_id: number;
      verifying_contract: string;
    }>(),
    /**
     * The SP1 Groth16 proof that the engine program, run over the purchase's inputs, gives the
     * countersign's `evalHash`, and the `EngineProofVerifier.record` transaction that verified it.
     */
    engineProof: jsonb().$type<EngineProof>(),
    /**
     * A paid and verified engine proof not yet recorded on chain, so that recording it again
     * never pays for another one.
     */
    engineProved: jsonb().$type<EngineProved>(),
    /**
     * The Succinct Prover Network request paying for this purchase's engine proof, kept before
     * waiting for it so that a run that dies while waiting resumes it rather than paying again.
     */
    engineRequest: text(),
    /**
     * What the operator attested about the item the coverage backs, fixed by the first cover
     * attempt: the product page, the amber fields, the salt and their `amberCommitment`.
     */
    amber: jsonb().$type<StoredAmber>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("purchases_amount_positive", sql`${t.amountMinor} > 0`),
    check("purchases_countersign_mode_valid", sql`${t.countersignMode} in ('2of2', 'degraded')`),
    check("purchases_decision_valid", sql`${t.decision} in (1, 2)`),
    check("purchases_cart_hash_len", sql`octet_length(${t.cartHash}) = 32`),
    check("purchases_countersign_digest_len", sql`octet_length(${t.countersignDigest}) = 32`),
    check("purchases_paypal_ref_salt_len", sql`octet_length(${t.paypalRefSalt}) = 32`),
    check("purchases_premium_bps_range", sql`${t.premiumBps} between 0 and 10000`),
    check(
      "purchases_paypal_transaction_id_live",
      sql`${t.paypalTransactionId} is null or ${t.liveStore} is not null`,
    ),
    check("purchases_capture_seq_range", sql`${t.captureSeq} between 1 and 99`),
    unique("purchases_mandate_id_capture_seq_unique").on(t.mandateId, t.captureSeq),
    index("purchases_resumable_idx")
      .on(t.leaseUntil)
      .where(sql`${t.state} in ('COUNTERSIGNED', 'LOGGED', 'COVERED')`),
    index("purchases_mandate_id_created_at_idx").on(t.mandateId, t.createdAt.desc(), t.id.desc()),
    index("purchases_merchant_id_created_at_idx").on(t.merchantId, t.createdAt.desc()),
    index("purchases_open_created_at_idx").on(t.createdAt, t.id).where(openPurchase(t.state)),
  ],
);

/** An engine proof as the prover returns it, before it is recorded. */
export type EngineProved = Omit<
  EngineProof,
  "chain_id" | "verifier" | "tx" | "gas_used" | "proven_at"
>;

/** An SP1 proof of a purchase's engine evaluation, as `purchases.engine_proof` stores it. */
export interface EngineProof {
  vkey: string;
  public_values: string;
  proof: string;
  eval_hash: string;
  countersign_digest: string;
  cycles: number;
  prove_ms: number;
  proof_bytes: number;
  sp1_version: string;
  /** The Succinct Prover Network request that proved it; amounts are PROVE wei. */
  network?: {
    request_id: string;
    explorer: string;
    gas_limit: number;
    gas_used: number | null;
    max_cost: string;
    cost: string | null;
    balance: string | null;
  };
  chain_id: number;
  verifier: string;
  tx: string;
  gas_used: string;
  proven_at: string;
}
