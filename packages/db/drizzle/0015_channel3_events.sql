CREATE TABLE "channel3_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"product_id" text,
	"domain" text,
	"committed_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"svix_id" text NOT NULL,
	"body" "bytea" NOT NULL,
	"content_hash" "bytea" NOT NULL,
	CONSTRAINT "channel3_events_content_hash_len" CHECK (octet_length("channel3_events"."content_hash") = 32)
);
--> statement-breakpoint
CREATE INDEX "channel3_events_product_domain_committed_at_idx" ON "channel3_events" USING btree ("product_id","domain","committed_at" DESC NULLS LAST);