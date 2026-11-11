CREATE TABLE "card_authorizations" (
	"id" text PRIMARY KEY NOT NULL,
	"transaction_token" text NOT NULL,
	"purchase_id" char(26) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"mcc" char(4) NOT NULL,
	"merchant_name" text NOT NULL,
	"merchant_country" text NOT NULL,
	"network_id" text NOT NULL,
	"approved" boolean NOT NULL,
	"failed_mask" integer NOT NULL,
	"reason" text,
	"tdx" jsonb,
	"nitro" jsonb,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_authorizations_mcc" CHECK ("card_authorizations"."mcc" ~ '^[0-9]{4}$'),
	CONSTRAINT "card_authorizations_approved_signed" CHECK (not "card_authorizations"."approved" or ("card_authorizations"."tdx" is not null and "card_authorizations"."nitro" is not null))
);
--> statement-breakpoint
CREATE TABLE "card_chargebacks" (
	"id" text PRIMARY KEY NOT NULL,
	"purchase_id" char(26) NOT NULL,
	"reason" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"status" text NOT NULL,
	"resolution" text,
	"recovered_minor" bigint,
	"evidence_uploaded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_chargebacks_amount_positive" CHECK ("card_chargebacks"."amount_minor" > 0),
	CONSTRAINT "card_chargebacks_reason_valid" CHECK ("card_chargebacks"."reason" in ('not_received', 'not_as_described', 'unauthorized'))
);
--> statement-breakpoint
CREATE TABLE "purchase_cards" (
	"purchase_id" char(26) PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"card_token" text NOT NULL,
	"last_four" char(4) NOT NULL,
	"controls" jsonb NOT NULL,
	"state" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"transaction_token" text,
	"settled_minor" bigint,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_cards_card_token_unique" UNIQUE("card_token"),
	CONSTRAINT "purchase_cards_transaction_token_unique" UNIQUE("transaction_token"),
	CONSTRAINT "purchase_cards_last_four" CHECK ("purchase_cards"."last_four" ~ '^[0-9]{4}$'),
	CONSTRAINT "purchase_cards_state_valid" CHECK ("purchase_cards"."state" in ('PAUSED', 'OPEN', 'USED', 'CLOSED'))
);
--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "rail" text DEFAULT 'paypal' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "rail" text DEFAULT 'paypal' NOT NULL;--> statement-breakpoint
ALTER TABLE "card_authorizations" ADD CONSTRAINT "card_authorizations_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_chargebacks" ADD CONSTRAINT "card_chargebacks_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_cards" ADD CONSTRAINT "purchase_cards_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "card_authorizations_purchase_id_created_at_idx" ON "card_authorizations" USING btree ("purchase_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "card_authorizations_one_approved_idx" ON "card_authorizations" USING btree ("purchase_id") WHERE "card_authorizations"."approved";--> statement-breakpoint
CREATE UNIQUE INDEX "card_chargebacks_one_open_idx" ON "card_chargebacks" USING btree ("purchase_id") WHERE "card_chargebacks"."status" not in ('CASE_WON', 'CASE_CLOSED');--> statement-breakpoint
CREATE INDEX "purchase_cards_open_expires_at_idx" ON "purchase_cards" USING btree ("expires_at") WHERE "purchase_cards"."state" in ('PAUSED', 'OPEN');--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_rail_valid" CHECK ("mandates"."rail" in ('paypal', 'card'));--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_rail_valid" CHECK ("purchases"."rail" in ('paypal', 'card'));