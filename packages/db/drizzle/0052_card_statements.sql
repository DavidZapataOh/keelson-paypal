CREATE TABLE "card_settlements" (
	"purchase_id" char(26) NOT NULL,
	"transaction_token" text NOT NULL,
	"transaction" "bytea" NOT NULL,
	"card" "bytea" NOT NULL,
	"settled_minor" bigint NOT NULL,
	"statement" "bytea" NOT NULL,
	"receipt" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "card_authorizations" ADD COLUMN "statement" "bytea";--> statement-breakpoint
ALTER TABLE "card_authorizations" ADD COLUMN "receipt" "bytea";--> statement-breakpoint
ALTER TABLE "card_settlements" ADD CONSTRAINT "card_settlements_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "card_settlements_transaction_idx" ON "card_settlements" USING btree ("purchase_id","transaction_token");