CREATE TABLE "chain_cursors" (
	"chain_id" integer PRIMARY KEY NOT NULL,
	"block" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chain_events" (
	"chain_id" integer NOT NULL,
	"tx_hash" "bytea" NOT NULL,
	"log_index" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" "bytea" NOT NULL,
	"address" "bytea" NOT NULL,
	"name" text NOT NULL,
	"args" jsonb NOT NULL,
	"finalized" boolean DEFAULT false NOT NULL,
	"handled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chain_events_pk" PRIMARY KEY("chain_id","tx_hash","log_index"),
	CONSTRAINT "chain_events_tx_hash_len" CHECK (octet_length("chain_events"."tx_hash") = 32)
);
--> statement-breakpoint
CREATE INDEX "chain_events_coverage_idx" ON "chain_events" USING btree ("chain_id","name",("args"->>'coverageId'));--> statement-breakpoint
CREATE INDEX "chain_events_block_idx" ON "chain_events" USING btree ("chain_id","block_number");--> statement-breakpoint
CREATE INDEX "chain_events_unhandled_idx" ON "chain_events" USING btree ("chain_id","name") WHERE "chain_events"."handled_at" is null;