CREATE TABLE "dispute_responses" (
	"id" char(26) PRIMARY KEY NOT NULL,
	"dispute_id" text NOT NULL,
	"action" text NOT NULL,
	"stage" text NOT NULL,
	"due_date" text NOT NULL,
	"input" jsonb NOT NULL,
	"draft" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dispute_responses_once" UNIQUE("dispute_id","action","stage","due_date"),
	CONSTRAINT "dispute_responses_action_valid" CHECK ("dispute_responses"."action" in ('provide_evidence', 'send_message', 'accept_claim'))
);
--> statement-breakpoint
ALTER TABLE "dispute_responses" ADD CONSTRAINT "dispute_responses_dispute_id_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE no action ON UPDATE no action;