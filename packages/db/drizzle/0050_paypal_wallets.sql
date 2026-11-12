CREATE TABLE "paypal_wallets" (
	"user_id" text PRIMARY KEY NOT NULL,
	"vault_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paypal_wallets_vault_id_unique" UNIQUE("vault_id")
);
--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "paypal_vault_id" text;--> statement-breakpoint
ALTER TABLE "paypal_wallets" ADD CONSTRAINT "paypal_wallets_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;