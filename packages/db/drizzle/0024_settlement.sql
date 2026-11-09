CREATE TABLE "merchant_settlement" (
	"merchant_id" text PRIMARY KEY NOT NULL,
	"rail" text NOT NULL,
	"paypal_receiver" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_settlement_rail_valid" CHECK ("merchant_settlement"."rail" in ('pyusd', 'paypal')),
	CONSTRAINT "merchant_settlement_receiver" CHECK ("merchant_settlement"."rail" = 'pyusd' or "merchant_settlement"."paypal_receiver" is not null)
);
--> statement-breakpoint
ALTER TABLE "verdicts" ADD COLUMN "rail" text DEFAULT 'pyusd' NOT NULL;--> statement-breakpoint
ALTER TABLE "verdicts" ADD COLUMN "refund_id" text;--> statement-breakpoint
ALTER TABLE "verdicts" ADD COLUMN "tx_id" char(26);--> statement-breakpoint
ALTER TABLE "verdicts" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "verdicts" ADD COLUMN "failure" text;--> statement-breakpoint
ALTER TABLE "verdicts" ADD COLUMN "ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verdicts" ADD COLUMN "payout_batch_id" text;--> statement-breakpoint
ALTER TABLE "verdicts" ADD COLUMN "payout_status" text;--> statement-breakpoint
ALTER TABLE "verdicts" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_rail_valid" CHECK ("verdicts"."rail" in ('pyusd', 'paypal'));--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_outcome_valid" CHECK ("verdicts"."outcome" in ('paid', 'queued', 'claimable', 'failed'));