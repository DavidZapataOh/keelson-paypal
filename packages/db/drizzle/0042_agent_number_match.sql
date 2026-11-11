ALTER TABLE "agent_connections" ADD COLUMN "match_number" smallint;--> statement-breakpoint
ALTER TABLE "agent_connections" ADD COLUMN "matched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_match_number" CHECK ("agent_connections"."match_number" is null or "agent_connections"."match_number" between 10 and 99);