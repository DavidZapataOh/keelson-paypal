CREATE TABLE "wallet_address" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wallet_address" ADD CONSTRAINT "wallet_address_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "walletAddress_userId_idx" ON "wallet_address" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "walletAddress_address_chainId_uidx" ON "wallet_address" USING btree ("address","chain_id");