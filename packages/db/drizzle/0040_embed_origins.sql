CREATE TABLE "embed_origins" (
	"client_id" text NOT NULL,
	"origin" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embed_origins_client_id_origin_pk" PRIMARY KEY("client_id","origin"),
	CONSTRAINT "embed_origins_https" CHECK ("embed_origins"."origin" ~ '^https://[^/?#]+$')
);
--> statement-breakpoint
ALTER TABLE "embed_origins" ADD CONSTRAINT "embed_origins_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;