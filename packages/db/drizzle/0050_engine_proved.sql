ALTER TABLE "purchases" ADD COLUMN "engine_proved" jsonb;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "engine_request" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "engine_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "engine_resumes" integer DEFAULT 0 NOT NULL;
