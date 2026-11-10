CREATE TABLE "user_set_roots" (
	"root" "bytea" PRIMARY KEY NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_set_roots_root_len" CHECK (octet_length("user_set_roots"."root") = 32),
	CONSTRAINT "user_set_roots_size_positive" CHECK ("user_set_roots"."size" > 0)
);
--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "c3_proof" jsonb;