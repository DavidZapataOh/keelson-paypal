import { sql } from "drizzle-orm";
import {
  char,
  check,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { bytea, createdAt } from "./types.ts";

/** A TEE signer admitted after its attestation verified. */
export const teeSigners = pgTable(
  "tee_signers",
  {
    address: bytea().primaryKey(),
    /** 1 for TDX (leg A), 2 for Nitro (leg B). */
    teeKind: smallint().notNull(),
    measurement: text().notNull(),
    binding: jsonb().notNull(),
    attestation: jsonb().notNull(),
    registeredAt: createdAt(),
    /** When the attestation behind the signer last verified. */
    verifiedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    revokedReason: text(),
  },
  (t) => [
    check("tee_signers_address_len", sql`octet_length(${t.address}) = 20`),
    check("tee_signers_tee_kind_valid", sql`${t.teeKind} in (1, 2)`),
  ],
);

/** The signatures the coordinator accepted: one digest per request and signer. */
export const teeSignatures = pgTable(
  "tee_signatures",
  {
    requestId: char({ length: 26 }).notNull(),
    signer: bytea().notNull(),
    digest: bytea().notNull(),
    signature: bytea().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: "tee_signatures_request_id_signer_pk", columns: [t.requestId, t.signer] }),
    check("tee_signatures_digest_len", sql`octet_length(${t.digest}) = 32`),
    check("tee_signatures_signature_len", sql`octet_length(${t.signature}) = 65`),
  ],
);
