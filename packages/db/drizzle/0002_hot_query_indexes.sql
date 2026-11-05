DROP INDEX "purchases_open_state_idx";--> statement-breakpoint
DROP INDEX "mandates_user_id_created_at_idx";--> statement-breakpoint
DROP INDEX "purchases_mandate_id_created_at_idx";--> statement-breakpoint
CREATE INDEX "purchases_open_created_at_idx" ON "purchases" USING btree ("created_at","id") WHERE "purchases"."state" not in ('SETTLED', 'DENIED', 'FAILED', 'SLASHED', 'WARRANTY_PAID', 'DEFENDED', 'MERCHANT_LIABLE');--> statement-breakpoint
CREATE INDEX "mandates_user_id_created_at_idx" ON "mandates" USING btree ("user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "purchases_mandate_id_created_at_idx" ON "purchases" USING btree ("mandate_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);