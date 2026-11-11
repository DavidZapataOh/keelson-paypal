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
ALTER TABLE "card_chargebacks" ADD CONSTRAINT "card_chargebacks_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "card_chargebacks_one_open_idx" ON "card_chargebacks" USING btree ("purchase_id") WHERE "card_chargebacks"."status" not in ('CASE_WON', 'CASE_CLOSED');