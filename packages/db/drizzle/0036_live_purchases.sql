ALTER TABLE "purchases" ADD COLUMN "live_store" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "paypal_transaction_id" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_paypal_transaction_id_unique" UNIQUE("paypal_transaction_id");--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_paypal_transaction_id_live" CHECK ("purchases"."paypal_transaction_id" is null or "purchases"."live_store" is not null);