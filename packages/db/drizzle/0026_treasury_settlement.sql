ALTER TABLE "verdicts" ADD COLUMN "paid_by" text;--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_paid_by_valid" CHECK ("verdicts"."paid_by" in ('chain', 'treasury'));--> statement-breakpoint
UPDATE "verdicts" SET "paid_by" = 'chain' WHERE "outcome" in ('paid', 'queued', 'claimable');
