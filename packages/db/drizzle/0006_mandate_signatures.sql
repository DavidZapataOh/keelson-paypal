ALTER TABLE "mandates" ADD COLUMN "payload_sd" jsonb;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "disclosures" jsonb;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "user_auth" jsonb;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "credential_id" text;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;