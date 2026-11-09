CREATE TABLE "paypal_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"source" text NOT NULL,
	"transmission_id" text,
	"transmission_time" timestamp with time zone,
	"cert_url" text,
	"headers" jsonb,
	"body" "bytea" NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"resource" jsonb,
	"resource_read_at" timestamp with time zone,
	"purchase_id" char(26),
	"mandate_id" char(26),
	"dispute_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"applied_at" timestamp with time zone,
	CONSTRAINT "paypal_events_transmission_id_unique" UNIQUE("transmission_id"),
	CONSTRAINT "paypal_events_source_valid" CHECK ("paypal_events"."source" in ('webhook', 'poll')),
	CONSTRAINT "paypal_events_status_valid" CHECK ("paypal_events"."status" in ('received', 'inflight', 'applied', 'ignored', 'mismatch', 'unresolvable', 'failed')),
	CONSTRAINT "paypal_events_lease_iff_inflight" CHECK (("paypal_events"."status" = 'inflight') = ("paypal_events"."lease_until" is not null)),
	CONSTRAINT "paypal_events_delivery_iff_webhook" CHECK (("paypal_events"."source" = 'webhook') = ("paypal_events"."transmission_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "paypal_events" ADD CONSTRAINT "paypal_events_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_events" ADD CONSTRAINT "paypal_events_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."mandates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_events" ADD CONSTRAINT "paypal_events_dispute_id_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paypal_events_received_next_attempt_at_idx" ON "paypal_events" USING btree ("next_attempt_at") WHERE "paypal_events"."status" = 'received';--> statement-breakpoint
CREATE INDEX "paypal_events_inflight_lease_until_idx" ON "paypal_events" USING btree ("lease_until") WHERE "paypal_events"."status" = 'inflight';--> statement-breakpoint
CREATE INDEX "paypal_events_resource_id_idx" ON "paypal_events" USING btree ("resource_id");