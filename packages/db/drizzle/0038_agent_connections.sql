CREATE TABLE "agent_connections" (
	"id" char(26) PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"client_id" text NOT NULL,
	"operator_agent_id" numeric(78, 0) NOT NULL,
	"name" text NOT NULL,
	"reason" text NOT NULL,
	"user_code" char(9) NOT NULL,
	"device_code_hash" "bytea" NOT NULL,
	"currency" char(3) NOT NULL,
	"per_purchase_minor" bigint NOT NULL,
	"total_minor" bigint NOT NULL,
	"ask_above_minor" bigint,
	"merchant_ids" text[] NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	"parent_mandate_id" char(26),
	"cart_hash" "bytea",
	"state" text DEFAULT 'PENDING' NOT NULL,
	"user_id" text,
	"mandate_id" char(26),
	"poll_interval" integer DEFAULT 5 NOT NULL,
	"polled_at" timestamp with time zone,
	"redeemed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_connections_user_code_unique" UNIQUE("user_code"),
	CONSTRAINT "agent_connections_device_code_hash_unique" UNIQUE("device_code_hash"),
	CONSTRAINT "agent_connections_kind_valid" CHECK ("agent_connections"."kind" in ('connect', 'once')),
	CONSTRAINT "agent_connections_state_valid" CHECK ("agent_connections"."state" in ('PENDING', 'APPROVED', 'DENIED')),
	CONSTRAINT "agent_connections_limits" CHECK ("agent_connections"."per_purchase_minor" > 0 and "agent_connections"."per_purchase_minor" <= "agent_connections"."total_minor" and ("agent_connections"."ask_above_minor" is null or "agent_connections"."ask_above_minor" between 1 and "agent_connections"."per_purchase_minor")),
	CONSTRAINT "agent_connections_approved" CHECK ("agent_connections"."state" <> 'APPROVED' or ("agent_connections"."mandate_id" is not null and "agent_connections"."user_id" is not null)),
	CONSTRAINT "agent_connections_once" CHECK ("agent_connections"."kind" <> 'once' or ("agent_connections"."parent_mandate_id" is not null and "agent_connections"."user_id" is not null and octet_length("agent_connections"."cart_hash") = 32))
);
--> statement-breakpoint
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_operator_agent_id_operators_agent_id_fk" FOREIGN KEY ("operator_agent_id") REFERENCES "public"."operators"("agent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_parent_mandate_id_mandates_id_fk" FOREIGN KEY ("parent_mandate_id") REFERENCES "public"."mandates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."mandates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_connections_user_id_operator_idx" ON "agent_connections" USING btree ("user_id","operator_agent_id");--> statement-breakpoint
CREATE INDEX "agent_connections_mandate_id_idx" ON "agent_connections" USING btree ("mandate_id");