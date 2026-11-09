ALTER TABLE "purchases" ADD COLUMN "client_id" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "paypal_order_id" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "paypal_authorization_id" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "paypal_ref_salt" "bytea";--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "capture_seq" smallint;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "capture_status" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "coverage_tx_id" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "coverage_tx_hash" "bytea";--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "captured_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "eval_trace" jsonb;--> statement-breakpoint
CREATE INDEX "purchases_resumable_idx" ON "purchases" USING btree ("lease_until") WHERE "purchases"."state" in ('COUNTERSIGNED', 'LOGGED', 'COVERED');--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_mandate_id_capture_seq_unique" UNIQUE("mandate_id","capture_seq");--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_paypal_ref_salt_len" CHECK (octet_length("purchases"."paypal_ref_salt") = 32);--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_capture_seq_range" CHECK ("purchases"."capture_seq" between 1 and 99);