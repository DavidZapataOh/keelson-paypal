CREATE TABLE "agent_stops" (
	"id" char(26) PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"mandate_hashes" text[] DEFAULT '{}' NOT NULL,
	"revoked" integer DEFAULT 0 NOT NULL,
	"released" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"releasing" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"leaf" "bytea",
	"log_indexes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"logged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_stops_revoked_nonnegative" CHECK ("agent_stops"."revoked" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agent_stops" ADD CONSTRAINT "agent_stops_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_stops_user_id_created_at_idx" ON "agent_stops" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_stops_unlogged_idx" ON "agent_stops" USING btree ("created_at") WHERE "agent_stops"."logged_at" is null;