CREATE TABLE "amber_convictions" (
	"coverage_id" "bytea" PRIMARY KEY NOT NULL,
	"purchase_id" char(26),
	"chain_id" integer NOT NULL,
	"field_id" smallint NOT NULL,
	"proven_at" timestamp with time zone NOT NULL,
	"web_fact_digest" "bytea" NOT NULL,
	"tx_hash" "bytea" NOT NULL,
	"block_number" bigint NOT NULL,
	"proof" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "amber_convictions_coverage_id_len" CHECK (octet_length("amber_convictions"."coverage_id") = 32),
	CONSTRAINT "amber_convictions_field_id_range" CHECK ("amber_convictions"."field_id" between 1 and 4)
);
--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "amber" jsonb;--> statement-breakpoint
CREATE INDEX "amber_convictions_purchase_id_idx" ON "amber_convictions" USING btree ("purchase_id");