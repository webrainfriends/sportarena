-- Physio rehab tracking: outcome measures, rehab goals, home-exercise adherence, progress reports and suggestion snoozes.
-- Additive only: new tables, no existing row is touched or removed. Session notes reuse clinical_encounters (no second notes table).
-- Everything here is clinical: free text is encrypted, readers need the same verified credential + active full consent as treatment plans,
-- and nothing is deleted (a wrong reading is voided with a reason, a goal is closed, a report gets a new immutable version).

-- Measured readings over time (pain, range of motion, strength...). Append-only; a wrong reading is voided, never edited.
CREATE TABLE physio_outcomes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id   uuid NOT NULL REFERENCES users,
  provider_id  uuid NOT NULL REFERENCES users,
  plan_id      uuid REFERENCES treatment_plans,
  encounter_id uuid REFERENCES clinical_encounters,
  measure      text NOT NULL CHECK (measure IN ('pain','range_of_motion','strength','function_score','balance_hold','swelling')),
  body_region  text CHECK (body_region IN ('neck','shoulder','elbow','wrist_hand','upper_back','lower_back','hip','knee','ankle_foot','core','full_body')),
  side         text CHECK (side IN ('left','right','both')),
  value        numeric NOT NULL,
  measured_at  timestamptz NOT NULL DEFAULT now(),
  note_enc     text,
  voided_at    timestamptz,
  voided_by    uuid REFERENCES users,
  void_reason_enc text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((voided_at IS NULL) = (void_reason_enc IS NULL))
);
CREATE INDEX physio_outcomes_patient ON physio_outcomes (patient_id, measure, measured_at DESC);
CREATE INDEX physio_outcomes_provider ON physio_outcomes (provider_id, measured_at DESC);

-- Rehab goals. A goal with a measure tracks progress from its baseline to its target against the outcome readings.
CREATE TABLE physio_goals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id   uuid NOT NULL REFERENCES users,
  provider_id  uuid NOT NULL REFERENCES users,
  plan_id      uuid REFERENCES treatment_plans,
  title_enc    text NOT NULL,
  measure      text CHECK (measure IN ('pain','range_of_motion','strength','function_score','balance_hold','swelling')),
  body_region  text CHECK (body_region IN ('neck','shoulder','elbow','wrist_hand','upper_back','lower_back','hip','knee','ankle_foot','core','full_body')),
  side         text CHECK (side IN ('left','right','both')),
  baseline     numeric,
  target       numeric,
  target_date  date,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','achieved','not_met','discontinued')),
  shared       boolean NOT NULL DEFAULT true,           -- the patient sees shared goals; the rest stay with the clinician
  closed_at    timestamptz,
  closing_note_enc text,
  row_version  int NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (measure IS NULL OR (baseline IS NOT NULL AND target IS NOT NULL)),
  CHECK ((status = 'active') = (closed_at IS NULL))
);
CREATE INDEX physio_goals_patient ON physio_goals (patient_id, status, created_at DESC);
CREATE INDEX physio_goals_provider ON physio_goals (provider_id, status, target_date);

-- What the patient says they did at home. Append-only; for a day the latest entry counts.
CREATE TABLE treatment_plan_adherence (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id     uuid NOT NULL REFERENCES treatment_plans,
  patient_id  uuid NOT NULL REFERENCES users,
  version_no  int NOT NULL,
  done_on     date NOT NULL,
  status      text NOT NULL CHECK (status IN ('done','partial','skipped')),
  pain        smallint CHECK (pain BETWEEN 0 AND 10),
  effort      smallint CHECK (effort BETWEEN 0 AND 10),
  note_enc    text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX treatment_plan_adherence_plan ON treatment_plan_adherence (plan_id, done_on DESC, created_at DESC);
CREATE INDEX treatment_plan_adherence_patient ON treatment_plan_adherence (patient_id, done_on DESC);

-- Progress reports: an editable draft; publishing freezes a numbered snapshot built on the server (same model as coaching reports).
CREATE TABLE physio_reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES users,
  patient_id  uuid NOT NULL REFERENCES users,
  plan_id     uuid REFERENCES treatment_plans,
  kind        text NOT NULL DEFAULT 'progress' CHECK (kind IN ('progress','discharge')),
  title       text NOT NULL CHECK (length(title) BETWEEN 2 AND 160),
  audience    text NOT NULL DEFAULT 'private' CHECK (audience IN ('private','patient')),
  period_from date NOT NULL,
  period_to   date NOT NULL,
  narrative_enc text,
  latest_version int NOT NULL DEFAULT 0,
  row_version int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (period_to >= period_from)
);
CREATE INDEX physio_reports_provider ON physio_reports (provider_id, updated_at DESC);
CREATE INDEX physio_reports_patient ON physio_reports (patient_id);

CREATE TABLE physio_report_versions (
  report_id    uuid NOT NULL REFERENCES physio_reports,
  version      int NOT NULL,
  audience     text NOT NULL,
  snapshot_enc text NOT NULL,
  snapshot_sha256 text NOT NULL,
  published_by uuid NOT NULL REFERENCES users,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, version)
);
CREATE FUNCTION physio_report_versions_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'physio_report_versions are immutable: publish a new version instead'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER physio_report_versions_immutable BEFORE UPDATE OR DELETE ON physio_report_versions FOR EACH ROW EXECUTE FUNCTION physio_report_versions_immutable();

-- The patient reading a published version (kept apart so the version itself stays immutable).
CREATE TABLE physio_report_reads (
  report_id  uuid NOT NULL,
  version    int NOT NULL,
  patient_id uuid NOT NULL REFERENCES users,
  read_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, version),
  FOREIGN KEY (report_id, version) REFERENCES physio_report_versions
);

-- "Not now" on a suggestion. Rows are only ever added; the latest `until` wins.
CREATE TABLE physio_suggestion_snoozes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES users,
  key         text NOT NULL,
  until       timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX physio_suggestion_snoozes_provider ON physio_suggestion_snoozes (provider_id, key, until DESC);
