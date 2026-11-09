ALTER TABLE "alibis" ADD COLUMN "anchor" jsonb;--> statement-breakpoint
ALTER TABLE "alibis" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;