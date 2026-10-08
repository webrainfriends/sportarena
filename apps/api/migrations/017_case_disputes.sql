-- Disputes on game data: routing to game officials, fixtures as a linkable record, and an immutable correction ledger.
ALTER TABLE case_links DROP CONSTRAINT case_links_entity_type_check;
ALTER TABLE case_links ADD CONSTRAINT case_links_entity_type_check CHECK (entity_type IN ('reservation','booking','invoice','payment','shop_order','coach_hire','event','game','fixture','appointment','insurance_policy','sponsorship'));

-- who handles the case: the platform team, or the officials of the game/event it is about (platform team can always step in)
ALTER TABLE cases ADD COLUMN routed_to text NOT NULL DEFAULT 'platform' CHECK (routed_to IN ('platform','game_officials'));
CREATE INDEX cases_routed ON cases (routed_to, status);

-- Before/after of every accepted correction. The source record is changed only through its own capability; this is the evidence.
CREATE TABLE case_corrections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES cases,
  target_type text NOT NULL CHECK (target_type IN ('game_participant','fixture')),
  target_id   uuid NOT NULL,
  field       text NOT NULL,
  before      jsonb,
  after       jsonb,
  applied_by  uuid NOT NULL REFERENCES users,
  applied_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_corrections_case ON case_corrections (case_id);

-- The case timeline and correction ledger are append-only: any UPDATE or DELETE is refused.
CREATE FUNCTION case_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER case_events_append_only BEFORE UPDATE OR DELETE ON case_events FOR EACH ROW EXECUTE FUNCTION case_append_only();
CREATE TRIGGER case_corrections_append_only BEFORE UPDATE OR DELETE ON case_corrections FOR EACH ROW EXECUTE FUNCTION case_append_only();
