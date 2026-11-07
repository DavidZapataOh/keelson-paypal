ALTER TABLE "purchases" ADD COLUMN "countersign_mode" text;--> statement-breakpoint
UPDATE "tee_signers" SET "revoked_at" = now(), "revoked_reason" = 'superseded'
WHERE "revoked_at" IS NULL AND "address" NOT IN (
  SELECT DISTINCT ON ("tee_kind") "address" FROM "tee_signers" WHERE "revoked_at" IS NULL
  ORDER BY "tee_kind", "registered_at" DESC
);--> statement-breakpoint
CREATE UNIQUE INDEX "tee_signers_active_tee_kind_uidx" ON "tee_signers" USING btree ("tee_kind") WHERE "tee_signers"."revoked_at" is null;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_countersign_mode_valid" CHECK ("purchases"."countersign_mode" in ('2of2', 'degraded'));--> statement-breakpoint
INSERT INTO "state_transitions" ("entity", "from_state", "to_state") VALUES ('purchases', 'FAILED', 'EVALUATING');