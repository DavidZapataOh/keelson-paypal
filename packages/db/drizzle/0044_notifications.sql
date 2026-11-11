CREATE TABLE "alert_emails" (
	"user_id" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"confirm_nonce" text,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" char(26) PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint"),
	CONSTRAINT "push_subscriptions_https" CHECK ("push_subscriptions"."endpoint" like 'https://%')
);
--> statement-breakpoint
CREATE TABLE "sent_emails" (
	"id" char(26) PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"address" text NOT NULL,
	"event" text NOT NULL,
	"subject" text NOT NULL,
	"subject_id" text,
	"log_index" numeric(20, 0),
	"alibi_url" text,
	"provider_id" text,
	"sent_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_connections" ADD COLUMN "cart" jsonb;--> statement-breakpoint
ALTER TABLE "agent_connections" ADD COLUMN "checks" jsonb;--> statement-breakpoint
ALTER TABLE "alert_emails" ADD CONSTRAINT "alert_emails_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sent_emails" ADD CONSTRAINT "sent_emails_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_id_idx" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sent_emails_user_id_created_at_idx" ON "sent_emails" USING btree ("user_id","created_at" DESC NULLS LAST);