-- Doctor workspace (issue #212, slice 3a): versioned sports clearance decisions with provenance, restrictions and expiry. Additive only.
-- medical_records.clearance (legacy) is untouched and still read: the fit-to-play projection uses whichever decision is more recent.
CREATE TABLE IF NOT EXISTS clinical_clearances (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id    uuid NOT NULL REFERENCES users,
  doctor_id     uuid NOT NULL REFERENCES users,
  sport_id      uuid REFERENCES sports,
  activity      text,
  status        text NOT NULL CHECK (status IN ('cleared','restricted','not_cleared')),
  restrictions_enc text,           -- JSON [{activity, limit}] shown in the minimum-necessary projection: no diagnosis
  internal_note_enc text,          -- doctor/athlete only, never in a projection
  assessed_on   date NOT NULL,
  valid_until   date,
  review_by     date,
  supersedes_id uuid REFERENCES clinical_clearances,
  superseded_at timestamptz,
  withdrawn_at  timestamptz,
  withdrawn_by  uuid REFERENCES users,
  withdrawn_reason_enc text,
  credential_case_id uuid REFERENCES verification_cases,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'not_cleared' OR valid_until IS NOT NULL),
  CHECK (valid_until IS NULL OR valid_until >= assessed_on),
  CHECK (review_by IS NULL OR review_by >= assessed_on),
  CHECK (status <> 'restricted' OR restrictions_enc IS NOT NULL)
);
-- one live decision per athlete and sport (general = no sport)
CREATE UNIQUE INDEX IF NOT EXISTS clinical_clearances_one_live ON clinical_clearances (athlete_id, COALESCE(sport_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE superseded_at IS NULL AND withdrawn_at IS NULL;
CREATE INDEX IF NOT EXISTS clinical_clearances_athlete ON clinical_clearances (athlete_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS clinical_clearances_doctor ON clinical_clearances (doctor_id, created_at DESC, id);

CREATE OR REPLACE FUNCTION clinical_clearances_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'clearance decisions are never deleted' USING ERRCODE = 'check_violation'; END IF;
  IF NEW.athlete_id <> OLD.athlete_id OR NEW.doctor_id <> OLD.doctor_id OR NEW.sport_id IS DISTINCT FROM OLD.sport_id OR NEW.status <> OLD.status OR NEW.activity IS DISTINCT FROM OLD.activity
     OR NEW.restrictions_enc IS DISTINCT FROM OLD.restrictions_enc OR NEW.internal_note_enc IS DISTINCT FROM OLD.internal_note_enc OR NEW.assessed_on <> OLD.assessed_on
     OR NEW.valid_until IS DISTINCT FROM OLD.valid_until OR NEW.review_by IS DISTINCT FROM OLD.review_by OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
     OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at) OR (OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at) THEN
    RAISE EXCEPTION 'clearance decisions are immutable; issue a new decision or withdraw this one' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS clinical_clearances_guard ON clinical_clearances;
CREATE TRIGGER clinical_clearances_guard BEFORE UPDATE OR DELETE ON clinical_clearances FOR EACH ROW EXECUTE FUNCTION clinical_clearances_guard();
