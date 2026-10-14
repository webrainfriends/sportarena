-- Doctor workspace (issue #212, slice 2b): investigation requests and results review. Additive only.
-- A result being received or opened is NOT a doctor review. Review, patient communication and closure are explicit, owned, timestamped steps.
-- Amended results are new versions that reopen review; earlier versions and review actions are kept.
CREATE TABLE IF NOT EXISTS clinical_investigations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id    uuid NOT NULL REFERENCES users,
  requested_by  uuid NOT NULL REFERENCES users,
  responsible_id uuid NOT NULL REFERENCES users,
  encounter_id  uuid,
  test_enc      text NOT NULL,
  indication_enc text,
  priority      text NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine','priority','urgent')),
  external_provider text,
  external_reference text,
  requested_on  date NOT NULL DEFAULT current_date,
  review_due    date,
  -- requested = awaiting a result; received = a result (latest version) awaits doctor review
  status        text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','received','reviewed','patient_informed','closed')),
  version       int NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clinical_investigations_patient ON clinical_investigations (athlete_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS clinical_investigations_queue ON clinical_investigations (responsible_id, status, review_due, id) WHERE status <> 'closed';

CREATE TABLE IF NOT EXISTS clinical_results (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investigation_id uuid NOT NULL REFERENCES clinical_investigations,
  version_no       int NOT NULL,
  uploaded_by      uuid NOT NULL REFERENCES users,
  source           text NOT NULL CHECK (source IN ('patient','provider','external')),
  values_enc       text NOT NULL,         -- JSON: [{name,value,unit,reference_interval,specimen_date}] exactly as supplied; nothing normalised
  document_ref     text,
  content_hash     text NOT NULL,
  extraction       text NOT NULL DEFAULT 'manual' CHECK (extraction IN ('manual','unverified_extraction')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (investigation_id, version_no),
  UNIQUE (investigation_id, content_hash)   -- a retried upload cannot create duplicate work
);

CREATE TABLE IF NOT EXISTS clinical_investigation_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investigation_id uuid NOT NULL REFERENCES clinical_investigations,
  result_id        uuid REFERENCES clinical_results,
  actor_id         uuid NOT NULL REFERENCES users,
  action           text NOT NULL CHECK (action IN ('requested','result_received','reviewed','patient_informed','reassigned','closed','reopened')),
  note_enc         text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clinical_investigation_events_inv ON clinical_investigation_events (investigation_id, created_at, id);

CREATE OR REPLACE FUNCTION clinical_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS clinical_results_append_only ON clinical_results;
CREATE TRIGGER clinical_results_append_only BEFORE UPDATE OR DELETE ON clinical_results FOR EACH ROW EXECUTE FUNCTION clinical_append_only();
DROP TRIGGER IF EXISTS clinical_investigation_events_append_only ON clinical_investigation_events;
CREATE TRIGGER clinical_investigation_events_append_only BEFORE UPDATE OR DELETE ON clinical_investigation_events FOR EACH ROW EXECUTE FUNCTION clinical_append_only();
