CREATE TABLE "risk_calibrations" (
	"id" char(26) PRIMARY KEY NOT NULL,
	"body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "premium_bps" smallint;--> statement-breakpoint
CREATE INDEX "risk_calibrations_created_at_idx" ON "risk_calibrations" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mandates_operator_agent_id_idx" ON "mandates" USING btree ("operator_agent_id");--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_premium_bps_range" CHECK ("purchases"."premium_bps" between 0 and 10000);--> statement-breakpoint
UPDATE "purchases" SET "premium_bps" = 100 WHERE "state" IN ('COUNTERSIGNED', 'LOGGED');
