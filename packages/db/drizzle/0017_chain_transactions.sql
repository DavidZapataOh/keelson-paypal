CREATE TYPE "public"."chain_tx_status" AS ENUM('simulating', 'pending', 'confirmed', 'reverted', 'dropped', 'rejected');--> statement-breakpoint
CREATE TABLE "chain_txs" (
	"id" char(26) PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"key" text NOT NULL,
	"contract" text NOT NULL,
	"function" text NOT NULL,
	"sender" "bytea" NOT NULL,
	"to" "bytea" NOT NULL,
	"data" "bytea" NOT NULL,
	"data_hash" "bytea" NOT NULL,
	"nonce" bigint,
	"hash" "bytea",
	"raw" "bytea",
	"status" "chain_tx_status" NOT NULL,
	"error_code" text,
	"error" jsonb,
	"gas_limit" bigint,
	"gas_used" bigint,
	"effective_gas_price" numeric(78, 0),
	"block_number" bigint,
	"block_hash" "bytea",
	"submitted_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chain_txs_chain_id_key_unique" UNIQUE("chain_id","key"),
	CONSTRAINT "chain_txs_data_hash_len" CHECK (octet_length("chain_txs"."data_hash") = 32),
	CONSTRAINT "chain_txs_sender_len" CHECK (octet_length("chain_txs"."sender") = 20)
);
--> statement-breakpoint
CREATE TABLE "relayer_nonces" (
	"chain_id" integer NOT NULL,
	"address" "bytea" NOT NULL,
	"next" bigint NOT NULL,
	CONSTRAINT "relayer_nonces_pk" PRIMARY KEY("chain_id","address"),
	CONSTRAINT "relayer_nonces_address_len" CHECK (octet_length("relayer_nonces"."address") = 20)
);
--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "validation_tx_id" char(26);--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "validation_skipped_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "chain_txs_sender_nonce_uidx" ON "chain_txs" USING btree ("chain_id","sender","nonce") WHERE "chain_txs"."status" in ('pending', 'confirmed', 'reverted');--> statement-breakpoint
CREATE INDEX "chain_txs_pending_idx" ON "chain_txs" USING btree ("updated_at") WHERE "chain_txs"."status" = 'pending';