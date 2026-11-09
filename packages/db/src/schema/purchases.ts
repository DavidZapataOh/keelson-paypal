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
    /** The salt of the leaf's `paypal_ref_commit`. */
    paypalRefSalt: bytea(),
    /** The capture's sequence number among the mandate's captures, as its `invoice_id` states it. */
    captureSeq: smallint(),
    /** PayPal's status of the capture. */
    captureStatus: text(),
    /** The relayed `lockCoverage` of the purchase. */
    coverageTxId: text(),
    coverageTxHash: bytea(),
    /** The purchase is being driven by one process until then. */
    leaseUntil: timestamp({ withTimezone: true }),
    capturedAt: timestamp({ withTimezone: true }),
    /** The `keelson.eval/1` trace both legs signed over; its hash is the countersign's `evalHash`. */
    evalTrace: jsonb(),
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
