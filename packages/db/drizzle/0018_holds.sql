CREATE TABLE "purchase_holds" (
	"request_id" char(26) PRIMARY KEY NOT NULL,
	"mandate_id" char(26) NOT NULL,
	"merchant_id" text NOT NULL,
	"currency" char(3) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"cart_hash" "bytea" NOT NULL,
	"paypal_order_id" text NOT NULL,
	"paypal_authorization_id" text,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_holds_paypal_order_id_unique" UNIQUE("paypal_order_id"),
	CONSTRAINT "purchase_holds_paypal_authorization_id_unique" UNIQUE("paypal_authorization_id"),
	CONSTRAINT "purchase_holds_amount_positive" CHECK ("purchase_holds"."amount_minor" > 0),
	CONSTRAINT "purchase_holds_cart_hash_len" CHECK (octet_length("purchase_holds"."cart_hash") = 32),
	CONSTRAINT "purchase_holds_state_valid" CHECK ("purchase_holds"."state" in ('PENDING', 'AUTHORIZED', 'CAPTURED', 'VOIDED'))
);
--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "hold_mode" text DEFAULT 'mandate' NOT NULL;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "paypal_parent_authorization_id" text;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "authorized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "reauthorized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "hold_error" text;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "revoke_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "purchase_holds" ADD CONSTRAINT "purchase_holds_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."mandates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchase_holds_mandate_id_created_at_idx" ON "purchase_holds" USING btree ("mandate_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_paypal_parent_authorization_id_unique" UNIQUE("paypal_parent_authorization_id");--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_hold_mode_valid" CHECK ("mandates"."hold_mode" in ('mandate', 'per_purchase'));--> statement-breakpoint
INSERT INTO "state_transitions" ("entity", "from_state", "to_state") VALUES ('mandates', 'SIGNED', 'ACTIVE');