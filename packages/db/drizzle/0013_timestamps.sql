CREATE TABLE "timestamps" (
	"hash" "bytea" NOT NULL,
	"kind" text NOT NULL,
	"tsa" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"token" "bytea",
	"gen_time" timestamp with time zone,
	"serial" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stamped_at" timestamp with time zone,
	CONSTRAINT "timestamps_hash_tsa_pk" PRIMARY KEY("hash","tsa"),
	CONSTRAINT "timestamps_hash_len" CHECK (octet_length("timestamps"."hash") = 32),
	CONSTRAINT "timestamps_kind_valid" CHECK ("timestamps"."kind" in ('leaf', 'channel3')),
	CONSTRAINT "timestamps_role_valid" CHECK ("timestamps"."role" in ('primary', 'fallback')),
	CONSTRAINT "timestamps_status_valid" CHECK ("timestamps"."status" in ('pending', 'inflight', 'stamped', 'failed')),
	CONSTRAINT "timestamps_lease_iff_inflight" CHECK (("timestamps"."status" = 'inflight') = ("timestamps"."lease_until" is not null)),
	CONSTRAINT "timestamps_token_iff_stamped" CHECK (("timestamps"."status" = 'stamped') = ("timestamps"."token" is not null))
);
--> statement-breakpoint
CREATE INDEX "timestamps_pending_next_attempt_at_idx" ON "timestamps" USING btree ("next_attempt_at") WHERE "timestamps"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "timestamps_inflight_lease_until_idx" ON "timestamps" USING btree ("lease_until") WHERE "timestamps"."status" = 'inflight';