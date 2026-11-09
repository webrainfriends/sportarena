-- Official report submission workflow, digital co-signing, evidence attachments, and discipline auto-trigger (#998).
-- Additive only: extends official_reports status, adds structured match facts and incident columns,
-- and creates three new tables (cosignatories, attachments, discipline auto-links).

-- 1. Extend official_reports status machine
ALTER TABLE official_reports DROP CONSTRAINT IF EXISTS official_reports_status_check;
ALTER TABLE official_reports ADD CONSTRAINT official_reports_status_check
  CHECK (status IN ('filed','revised','co_signing','submitted','accepted','queried'));

-- 2. Add structured columns and submission provenance to official_reports
ALTER TABLE official_reports
  ADD COLUMN IF NOT EXISTS match_facts        jsonb,
  ADD COLUMN IF NOT EXISTS incidents          jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS venue_incidents    jsonb,
  ADD COLUMN IF NOT EXISTS abandonment        jsonb,
  ADD COLUMN IF NOT EXISTS submitted_at       timestamptz,
  ADD COLUMN IF NOT EXISTS submitted_hash     text,
  ADD COLUMN IF NOT EXISTS locked             bool NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS disc_case_id       uuid REFERENCES gov_cases(id),
  ADD COLUMN IF NOT EXISTS event_id           uuid REFERENCES events(id),
  ADD COLUMN IF NOT EXISTS competition_id     uuid REFERENCES comp_competitions(id),
  ADD COLUMN IF NOT EXISTS query_note_enc     text,
  ADD COLUMN IF NOT EXISTS queried_at         timestamptz,
  ADD COLUMN IF NOT EXISTS queried_by         uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS accepted_at        timestamptz,
  ADD COLUMN IF NOT EXISTS accepted_by        uuid REFERENCES users(id);

CREATE INDEX IF NOT EXISTS official_reports_event ON official_reports(event_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS official_reports_competition ON official_reports(competition_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS official_reports_disc_case ON official_reports(disc_case_id) WHERE disc_case_id IS NOT NULL;

-- 3. Co-signatory table: multi-official sign-off per report
CREATE TABLE IF NOT EXISTS official_report_cosignatories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id       uuid NOT NULL REFERENCES official_reports(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  role            text NOT NULL,
  required        bool NOT NULL DEFAULT true,
  requested_at    timestamptz NOT NULL DEFAULT now(),
  requested_by    uuid NOT NULL REFERENCES users(id),
  signed_at       timestamptz,
  signature_hash  text,
  declined_at     timestamptz,
  decline_reason  text,
  UNIQUE (report_id, user_id)
);
CREATE INDEX IF NOT EXISTS report_cosig_report ON official_report_cosignatories(report_id);
CREATE INDEX IF NOT EXISTS report_cosig_user ON official_report_cosignatories(user_id, signed_at);

-- Immutable audit trigger: once a co-signatory row is signed it may not be changed
CREATE OR REPLACE FUNCTION trg_cosig_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.signed_at IS NOT NULL AND (NEW.signed_at IS DISTINCT FROM OLD.signed_at OR NEW.signature_hash IS DISTINCT FROM OLD.signature_hash) THEN
    RAISE EXCEPTION 'official_report_cosignatories: signed row is immutable';
  END IF;
  RETURN NEW;
END;$$;
DROP TRIGGER IF EXISTS cosig_immutable ON official_report_cosignatories;
CREATE TRIGGER cosig_immutable BEFORE UPDATE ON official_report_cosignatories FOR EACH ROW EXECUTE FUNCTION trg_cosig_immutable();

-- 4. Evidence attachments table
CREATE TABLE IF NOT EXISTS official_report_attachments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id       uuid NOT NULL REFERENCES official_reports(id),
  file_key        text NOT NULL,
  file_name       text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  mime_type       text NOT NULL,
  size_bytes      bigint NOT NULL CHECK (size_bytes > 0),
  description     text CHECK (description IS NULL OR length(description) <= 300),
  visibility      text NOT NULL DEFAULT 'organiser' CHECK (visibility IN ('author','organiser','federation')),
  uploaded_by     uuid NOT NULL REFERENCES users(id),
  uploaded_at     timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
);
CREATE INDEX IF NOT EXISTS report_attach_report ON official_report_attachments(report_id) WHERE archived_at IS NULL;

-- 5. Backfill event_id and competition_id for existing reports via fixture
UPDATE official_reports r
   SET event_id = f.event_id
  FROM fixtures f
 WHERE r.fixture_id = f.id AND r.event_id IS NULL;

UPDATE official_reports r
   SET competition_id = f.competition_id
  FROM fixtures f
 WHERE r.fixture_id = f.id AND r.competition_id IS NULL AND f.competition_id IS NOT NULL;
