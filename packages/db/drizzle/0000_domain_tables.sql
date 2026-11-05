CREATE TYPE "public"."attack_outcome" AS ENUM('BLOCKED', 'SUCCEEDED', 'NO_EFFECT');--> statement-breakpoint
CREATE TYPE "public"."dispute_state" AS ENUM('OPEN', 'ATTRIBUTED', 'RESOLVED');--> statement-breakpoint
CREATE TYPE "public"."mandate_state" AS ENUM('DRAFT', 'COMPILED', 'SIGNED', 'HOLD_PENDING', 'ACTIVE', 'EXHAUSTED', 'EXPIRED', 'REVOKED');--> statement-breakpoint
CREATE TYPE "public"."purchase_state" AS ENUM('PROPOSED', 'EVALUATING', 'DENIED', 'COUNTERSIGNED', 'LOGGED', 'COVERED', 'CAPTURED', 'DELIVERED', 'SETTLED', 'DISPUTED', 'ATTRIBUTED', 'SLASHED', 'WARRANTY_PAID', 'DEFENDED', 'MERCHANT_LIABLE', 'FAILED');--> statement-breakpoint
CREATE TABLE "alibis" (
	"purchase_id" char(26) PRIMARY KEY NOT NULL,
	"leaf_hash" "bytea" NOT NULL,
	"bundle" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alibis_leaf_hash_unique" UNIQUE("leaf_hash"),
	CONSTRAINT "alibis_leaf_hash_len" CHECK (octet_length("alibis"."leaf_hash") = 32)
);
--> statement-breakpoint
CREATE TABLE "attacks" (
	"id" char(26) PRIMARY KEY NOT NULL,
	"campaign" text NOT NULL,
	"backbone" text NOT NULL,
	"payload_hash" "bytea" NOT NULL,
	"outcome" "attack_outcome" NOT NULL,
	"purchase_id" char(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attacks_payload_hash_len" CHECK (octet_length("attacks"."payload_hash") = 32)
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" text PRIMARY KEY NOT NULL,
	"purchase_id" char(26) NOT NULL,
	"state" "dispute_state" DEFAULT 'OPEN' NOT NULL,
	"reason" text NOT NULL,
	"rule_id" smallint,
	"liable" smallint,
	"raw" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disputes_liable_valid" CHECK ("disputes"."liable" in (1, 2, 3, 4))
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"channel" text NOT NULL,
	"subject_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mandates" (
	"id" char(26) PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"operator_agent_id" numeric(78, 0) NOT NULL,
	"state" "mandate_state" DEFAULT 'DRAFT' NOT NULL,
	"currency" char(3) NOT NULL,
	"max_minor" bigint NOT NULL,
	"remaining_minor" bigint NOT NULL,
	"merchant_ids" text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"mandate_hash" "bytea",
	"commitment" "bytea",
	"paypal_order_id" text,
	"paypal_authorization_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mandates_mandate_hash_unique" UNIQUE("mandate_hash"),
	CONSTRAINT "mandates_paypal_order_id_unique" UNIQUE("paypal_order_id"),
	CONSTRAINT "mandates_paypal_authorization_id_unique" UNIQUE("paypal_authorization_id"),
	CONSTRAINT "mandates_remaining_within_max" CHECK ("mandates"."remaining_minor" between 0 and "mandates"."max_minor"),
	CONSTRAINT "mandates_mandate_hash_len" CHECK (octet_length("mandates"."mandate_hash") = 32),
	CONSTRAINT "mandates_commitment_len" CHECK (octet_length("mandates"."commitment") = 32)
);
--> statement-breakpoint
CREATE TABLE "operators" (
	"agent_id" numeric(78, 0) PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"name" text NOT NULL,
	"cnf_jwk" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchases" (
	"id" char(26) PRIMARY KEY NOT NULL,
	"mandate_id" char(26) NOT NULL,
	"state" "purchase_state" DEFAULT 'PROPOSED' NOT NULL,
	"failure_reason" text,
	"merchant_id" text NOT NULL,
	"currency" char(3) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"cart_hash" "bytea" NOT NULL,
	"countersign_digest" "bytea",
	"decision" smallint,
	"failed_fields_mask" integer,
	"invoice_id" varchar(60),
	"paypal_capture_id" text,
	"log_index" bigint,
	"anchored_size" bigint,
	"chain_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchases_countersign_digest_unique" UNIQUE("countersign_digest"),
	CONSTRAINT "purchases_invoice_id_unique" UNIQUE("invoice_id"),
	CONSTRAINT "purchases_paypal_capture_id_unique" UNIQUE("paypal_capture_id"),
	CONSTRAINT "purchases_log_index_unique" UNIQUE("log_index"),
	CONSTRAINT "purchases_amount_positive" CHECK ("purchases"."amount_minor" > 0),
	CONSTRAINT "purchases_decision_valid" CHECK ("purchases"."decision" in (1, 2)),
	CONSTRAINT "purchases_cart_hash_len" CHECK (octet_length("purchases"."cart_hash") = 32),
	CONSTRAINT "purchases_countersign_digest_len" CHECK (octet_length("purchases"."countersign_digest") = 32)
);
--> statement-breakpoint
CREATE TABLE "verdicts" (
	"id" char(26) PRIMARY KEY NOT NULL,
	"dispute_id" text NOT NULL,
	"liable" smallint NOT NULL,
	"rule_id" smallint NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"payee" text NOT NULL,
	"digest" "bytea" NOT NULL,
	"tx_hash" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verdicts_dispute_id_unique" UNIQUE("dispute_id"),
	CONSTRAINT "verdicts_digest_unique" UNIQUE("digest"),
	CONSTRAINT "verdicts_digest_len" CHECK (octet_length("verdicts"."digest") = 32),
	CONSTRAINT "verdicts_tx_hash_len" CHECK (octet_length("verdicts"."tx_hash") = 32)
);
--> statement-breakpoint
ALTER TABLE "alibis" ADD CONSTRAINT "alibis_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attacks" ADD CONSTRAINT "attacks_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_operator_agent_id_operators_agent_id_fk" FOREIGN KEY ("operator_agent_id") REFERENCES "public"."operators"("agent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."mandates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_dispute_id_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attacks_created_at_idx" ON "attacks" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "disputes_purchase_id_idx" ON "disputes" USING btree ("purchase_id");--> statement-breakpoint
CREATE INDEX "events_channel_id_idx" ON "events" USING btree ("channel","id");--> statement-breakpoint
CREATE INDEX "mandates_user_id_created_at_idx" ON "mandates" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "purchases_mandate_id_created_at_idx" ON "purchases" USING btree ("mandate_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "purchases_merchant_id_created_at_idx" ON "purchases" USING btree ("merchant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "purchases_open_state_idx" ON "purchases" USING btree ("state") WHERE "purchases"."state" not in ('SETTLED', 'DENIED', 'FAILED', 'SLASHED', 'WARRANTY_PAID', 'DEFENDED', 'MERCHANT_LIABLE');