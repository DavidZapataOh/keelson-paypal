CREATE TABLE "red_team_campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"header" text NOT NULL,
	"summary" text,
	"head" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "red_team_campaigns_head_len" CHECK (octet_length("red_team_campaigns"."head") = 32)
);
--> statement-breakpoint
ALTER TABLE "attacks" ADD COLUMN "seq" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "attacks" ADD COLUMN "line" text NOT NULL;--> statement-breakpoint
ALTER TABLE "attacks" ADD COLUMN "hash" "bytea" NOT NULL;--> statement-breakpoint
ALTER TABLE "attacks" ADD CONSTRAINT "attacks_campaign_red_team_campaigns_id_fk" FOREIGN KEY ("campaign") REFERENCES "public"."red_team_campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attacks_campaign_seq_idx" ON "attacks" USING btree ("campaign","seq");--> statement-breakpoint
ALTER TABLE "attacks" ADD CONSTRAINT "attacks_hash_len" CHECK (octet_length("attacks"."hash") = 32);