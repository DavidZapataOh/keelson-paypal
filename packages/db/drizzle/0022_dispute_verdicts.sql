ALTER TABLE "verdicts" ADD COLUMN "chain_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "verdicts" ADD COLUMN "message" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "verdicts" ADD COLUMN "signatures" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "verdicts" ADD COLUMN "facts" jsonb NOT NULL;