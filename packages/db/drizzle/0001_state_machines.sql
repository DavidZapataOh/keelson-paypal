CREATE TABLE "state_transitions" (
  "entity" text NOT NULL,
  "from_state" text NOT NULL,
  "to_state" text NOT NULL,
  CONSTRAINT "state_transitions_pk" PRIMARY KEY ("entity", "from_state", "to_state")
);
--> statement-breakpoint
INSERT INTO "state_transitions" ("entity", "from_state", "to_state") VALUES
  ('mandates', 'DRAFT', 'COMPILED'),
  ('mandates', 'COMPILED', 'SIGNED'),
  ('mandates', 'SIGNED', 'HOLD_PENDING'),
  ('mandates', 'SIGNED', 'REVOKED'),
  ('mandates', 'SIGNED', 'EXPIRED'),
  ('mandates', 'HOLD_PENDING', 'ACTIVE'),
  ('mandates', 'HOLD_PENDING', 'REVOKED'),
  ('mandates', 'HOLD_PENDING', 'EXPIRED'),
  ('mandates', 'ACTIVE', 'EXHAUSTED'),
  ('mandates', 'ACTIVE', 'EXPIRED'),
  ('mandates', 'ACTIVE', 'REVOKED'),
  ('purchases', 'PROPOSED', 'EVALUATING'),
  ('purchases', 'EVALUATING', 'DENIED'),
  ('purchases', 'EVALUATING', 'COUNTERSIGNED'),
  ('purchases', 'COUNTERSIGNED', 'LOGGED'),
  ('purchases', 'COUNTERSIGNED', 'FAILED'),
  ('purchases', 'LOGGED', 'COVERED'),
  ('purchases', 'LOGGED', 'FAILED'),
  ('purchases', 'COVERED', 'CAPTURED'),
  ('purchases', 'COVERED', 'FAILED'),
  ('purchases', 'CAPTURED', 'DELIVERED'),
  ('purchases', 'CAPTURED', 'SETTLED'),
  ('purchases', 'CAPTURED', 'DISPUTED'),
  ('purchases', 'DELIVERED', 'SETTLED'),
  ('purchases', 'DELIVERED', 'DISPUTED'),
  ('purchases', 'DISPUTED', 'ATTRIBUTED'),
  ('purchases', 'ATTRIBUTED', 'SLASHED'),
  ('purchases', 'ATTRIBUTED', 'WARRANTY_PAID'),
  ('purchases', 'ATTRIBUTED', 'DEFENDED'),
  ('purchases', 'ATTRIBUTED', 'MERCHANT_LIABLE'),
  ('disputes', 'OPEN', 'ATTRIBUTED'),
  ('disputes', 'OPEN', 'RESOLVED'),
  ('disputes', 'ATTRIBUTED', 'RESOLVED');
--> statement-breakpoint
CREATE FUNCTION keelson_enforce_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM state_transitions
    WHERE entity = TG_TABLE_NAME
      AND from_state = OLD.state::text
      AND to_state = NEW.state::text
  ) THEN
    RAISE EXCEPTION 'illegal transition % % -> %', TG_TABLE_NAME, OLD.state, NEW.state
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER mandates_enforce_transition
BEFORE UPDATE OF state ON "mandates"
FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state)
EXECUTE FUNCTION keelson_enforce_transition();
--> statement-breakpoint
CREATE TRIGGER purchases_enforce_transition
BEFORE UPDATE OF state ON "purchases"
FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state)
EXECUTE FUNCTION keelson_enforce_transition();
--> statement-breakpoint
CREATE TRIGGER disputes_enforce_transition
BEFORE UPDATE OF state ON "disputes"
FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state)
EXECUTE FUNCTION keelson_enforce_transition();
