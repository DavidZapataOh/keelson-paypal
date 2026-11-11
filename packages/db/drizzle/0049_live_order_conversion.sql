ALTER TABLE "purchases" ADD COLUMN "paypal_order_intent" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "paypal_payee_id" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "conversion" jsonb;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_paypal_order_intent_valid" CHECK ("purchases"."paypal_order_intent" is null or "purchases"."paypal_order_intent" in ('SALE', 'AUTHORIZE'));