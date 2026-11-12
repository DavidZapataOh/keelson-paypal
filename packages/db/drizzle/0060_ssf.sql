CREATE TABLE "ssf_events" (
	"jti" char(26) PRIMARY KEY NOT NULL,
	"stream_id" char(26) NOT NULL,
	"set" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ssf_streams" (
	"id" char(26) PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'enabled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ssf_events" ADD CONSTRAINT "ssf_events_stream_id_ssf_streams_id_fk" FOREIGN KEY ("stream_id") REFERENCES "public"."ssf_streams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssf_streams" ADD CONSTRAINT "ssf_streams_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ssf_events_pending_idx" ON "ssf_events" USING btree ("stream_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ssf_streams_client_id_user_id_idx" ON "ssf_streams" USING btree ("client_id","user_id");