CREATE TABLE "channel3_observations" (
	"id" char(26) PRIMARY KEY NOT NULL,
	"mandate_id" char(26) NOT NULL,
	"purchase_id" char(26),
	"requested_by" text NOT NULL,
	"url" text NOT NULL,
	"status" text NOT NULL,
	"document" jsonb NOT NULL,
	"content_hash" "bytea" NOT NULL,
	"salt" "bytea" NOT NULL,
	"raw" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel3_observations_purchaseId_unique" UNIQUE("purchase_id"),
	CONSTRAINT "channel3_observations_contentHash_unique" UNIQUE("content_hash"),
	CONSTRAINT "channel3_observations_status_valid" CHECK ("channel3_observations"."status" in ('ok', 'unavailable')),
	CONSTRAINT "channel3_observations_content_hash_len" CHECK (octet_length("channel3_observations"."content_hash") = 32),
	CONSTRAINT "channel3_observations_salt_len" CHECK (octet_length("channel3_observations"."salt") = 32),
	CONSTRAINT "channel3_observations_raw_size" CHECK (octet_length("channel3_observations"."raw") <= 524288)
);
--> statement-breakpoint
ALTER TABLE "channel3_observations" ADD CONSTRAINT "channel3_observations_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."mandates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel3_observations" ADD CONSTRAINT "channel3_observations_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel3_observations_mandate_id_created_at_idx" ON "channel3_observations" USING btree ("mandate_id","created_at" DESC NULLS LAST);