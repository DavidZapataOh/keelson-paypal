ALTER TABLE "purchases" ALTER COLUMN "failed_fields_mask" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "user_credential" text;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "open_mandate" text;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "sealed_salt" "bytea";--> statement-breakpoint
INSERT INTO "state_transitions" ("entity", "from_state", "to_state") VALUES ('purchases', 'EVALUATING', 'FAILED');
