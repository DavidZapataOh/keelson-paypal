CREATE TABLE "tee_signatures" (
	"request_id" char(26) NOT NULL,
	"signer" "bytea" NOT NULL,
	"digest" "bytea" NOT NULL,
	"signature" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tee_signatures_request_id_signer_pk" PRIMARY KEY("request_id","signer"),
	CONSTRAINT "tee_signatures_digest_len" CHECK (octet_length("tee_signatures"."digest") = 32),
	CONSTRAINT "tee_signatures_signature_len" CHECK (octet_length("tee_signatures"."signature") = 65)
);
--> statement-breakpoint
CREATE TABLE "tee_signers" (
	"address" "bytea" PRIMARY KEY NOT NULL,
	"tee_kind" smallint NOT NULL,
	"measurement" text NOT NULL,
	"binding" jsonb NOT NULL,
	"attestation" jsonb NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	CONSTRAINT "tee_signers_address_len" CHECK (octet_length("tee_signers"."address") = 20),
	CONSTRAINT "tee_signers_tee_kind_valid" CHECK ("tee_signers"."tee_kind" in (1, 2))
);
