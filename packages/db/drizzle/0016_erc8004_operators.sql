ALTER TABLE "operators" ADD COLUMN "agent_registry" text;--> statement-breakpoint
UPDATE "operators" SET "agent_registry" = 'eip155:' || "chain_id" || ':' || CASE "chain_id"
	WHEN 421614 THEN '0x8004A818BFB912233c491871b3d84c89A494BD9e'
	WHEN 11155111 THEN '0x8004A818BFB912233c491871b3d84c89A494BD9e'
	WHEN 42161 THEN '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'
END;--> statement-breakpoint
ALTER TABLE "operators" ALTER COLUMN "agent_registry" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "owner_address" "bytea";--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "countersign" jsonb;--> statement-breakpoint
ALTER TABLE "operators" ADD CONSTRAINT "operators_agent_registry_agent_id_unique" UNIQUE("agent_registry","agent_id");--> statement-breakpoint
ALTER TABLE "operators" ADD CONSTRAINT "operators_agent_registry_chain" CHECK ("operators"."agent_registry" like 'eip155:' || "operators"."chain_id" || ':0x%');--> statement-breakpoint
ALTER TABLE "operators" ADD CONSTRAINT "operators_owner_address_len" CHECK (octet_length("operators"."owner_address") = 20);