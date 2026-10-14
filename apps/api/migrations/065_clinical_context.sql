-- Doctor workspace (issue #212, slice 2a): provenance-aware problems, allergies and medications, plus explicit "none reported" / "unknown"
-- declarations. Additive only. Corrections never overwrite: a correction is a new row that supersedes the old one, which is kept.
-- Nothing here prescribes, checks interactions or infers safety; absence of data is "unknown", never "none".
CREATE TABLE IF NOT EXISTS clinical_context_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id    uuid NOT NULL REFERENCES users,
  kind          text NOT NULL CHECK (kind IN ('problem','allergy','medication')),
  status        text NOT NULL CHECK (status IN ('active','resolved','stopped','uncertain')),
  source        text NOT NULL CHECK (source IN ('patient_reported','clinician_recorded')),
  verification  text NOT NULL DEFAULT 'unverified' CHECK (verification IN ('unverified','confirmed','disputed')),
  label_enc     text NOT NULL,
  detail_enc    text,
  recorded_by   uuid NOT NULL REFERENCES users,
  reconciled_by uuid REFERENCES users,
  reconciled_at timestamptz,
  encounter_id  uuid,
  supersedes_id uuid REFERENCES clinical_context_entries,
  superseded_at timestamptz,
  review_date   date,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (verification = 'unverified' OR (reconciled_by IS NOT NULL AND reconciled_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS clinical_context_athlete ON clinical_context_entries (athlete_id, kind, created_at DESC, id) WHERE superseded_at IS NULL;
-- a row can be superseded at most once (a retried correction cannot fork the history)
CREATE UNIQUE INDEX IF NOT EXISTS clinical_context_one_successor ON clinical_context_entries (supersedes_id) WHERE supersedes_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS clinical_context_declarations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id  uuid NOT NULL REFERENCES users,
  kind        text NOT NULL CHECK (kind IN ('allergy','medication')),
  state       text NOT NULL CHECK (state IN ('none_reported','unknown')),
  source      text NOT NULL CHECK (source IN ('patient_reported','clinician_recorded')),
  recorded_by uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clinical_context_decl ON clinical_context_declarations (athlete_id, kind, created_at DESC, id);

-- append-only: entries may only be superseded/reconciled, never rewritten or removed
CREATE OR REPLACE FUNCTION clinical_context_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'clinical context is never deleted' USING ERRCODE = 'check_violation'; END IF;
  IF NEW.label_enc IS DISTINCT FROM OLD.label_enc OR NEW.detail_enc IS DISTINCT FROM OLD.detail_enc OR NEW.athlete_id <> OLD.athlete_id OR NEW.kind <> OLD.kind
     OR NEW.status <> OLD.status OR NEW.source <> OLD.source OR NEW.recorded_by <> OLD.recorded_by THEN
    RAISE EXCEPTION 'clinical context entries are immutable; add a correction instead' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS clinical_context_guard ON clinical_context_entries;
CREATE TRIGGER clinical_context_guard BEFORE UPDATE OR DELETE ON clinical_context_entries FOR EACH ROW EXECUTE FUNCTION clinical_context_guard();
