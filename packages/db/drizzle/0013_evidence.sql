CREATE TABLE "evidence_bundles" (
	"root" "bytea" PRIMARY KEY NOT NULL,
	"mandate_id" char(26) NOT NULL,
	"manifest" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_bundles_root_len" CHECK (octet_length("evidence_bundles"."root") = 32)
);
--> statement-breakpoint
CREATE TABLE "evidence_items" (
	"root" "bytea" NOT NULL,
	"index" smallint NOT NULL,
	"type" text NOT NULL,
	"media_type" text NOT NULL,
	"content_hash" "bytea" NOT NULL,
	"salt" "bytea" NOT NULL,
	"bytes" "bytea" NOT NULL,
	CONSTRAINT "evidence_items_root_index_pk" PRIMARY KEY("root","index"),
	CONSTRAINT "evidence_items_content_hash_len" CHECK (octet_length("evidence_items"."content_hash") = 32),
	CONSTRAINT "evidence_items_salt_len" CHECK (octet_length("evidence_items"."salt") = 32)
);
--> statement-breakpoint
ALTER TABLE "evidence_bundles" ADD CONSTRAINT "evidence_bundles_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."mandates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_root_evidence_bundles_root_fk" FOREIGN KEY ("root") REFERENCES "public"."evidence_bundles"("root") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_bundles_mandate_id_idx" ON "evidence_bundles" USING btree ("mandate_id");