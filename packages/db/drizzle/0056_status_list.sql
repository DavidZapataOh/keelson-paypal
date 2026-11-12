CREATE TABLE "status_lists" (
	"uri" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "status_idx" integer;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_status_idx_unique" UNIQUE("status_idx");