ALTER TABLE "mandates" ADD COLUMN "issuer_thumbprint" text;--> statement-breakpoint
-- Every mandate leg A issued so far was issued with the credential issuer key it held before the key moved.
UPDATE "mandates" SET "issuer_thumbprint" = '0x7d575028b1b6b7208962ac880eeb146675423d9e5441cfca0decf85bb4626253' WHERE "open_mandate" IS NOT NULL;
