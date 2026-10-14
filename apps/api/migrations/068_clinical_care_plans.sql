-- Doctor workspace (issue #212, slice 2d): versioned, patient-specific care plans. Additive only.
-- A plan has immutable published versions; a revision is a new draft that supersedes the published one when published. Patient entries
-- (done / unable / symptom) are a separate append-only log and never rewrite clinician instructions. Task completion is not clinical resolution.
CREATE TABLE IF NOT EXISTS clinical_care_plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id  uuid NOT NULL REFERENCES users,
  provider_id uuid NOT NULL REFERENCES users,
  title_enc   text NOT NULL,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','completed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clinical_care_plans_patient ON clinical_care_plans (athlete_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS clinical_care_plans_provider ON clinical_care_plans (provider_id, status, created_at DESC, id);

CREATE TABLE IF NOT EXISTS clinical_care_plan_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id     uuid NOT NULL REFERENCES clinical_care_plans,
  version_no  int  NOT NULL,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','superseded')),
  body_enc    text NOT NULL,
  row_version int  NOT NULL DEFAULT 1,
  published_at timestamptz,
  published_by uuid REFERENCES users,
  credential_case_id uuid REFERENCES verification_cases,
  superseded_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, version_no),
  CHECK (status = 'draft' OR (published_at IS NOT NULL AND published_by IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS clinical_care_plan_one_draft ON clinical_care_plan_versions (plan_id) WHERE status = 'draft';
CREATE UNIQUE INDEX IF NOT EXISTS clinical_care_plan_one_published ON clinical_care_plan_versions (plan_id) WHERE status = 'published';

CREATE TABLE IF NOT EXISTS clinical_care_plan_entries (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id    uuid NOT NULL REFERENCES clinical_care_plans,
  version_no int NOT NULL,
  action_key text,
  kind       text NOT NULL CHECK (kind IN ('completed','unable','symptom','clinician_confirmed','clinician_cancelled')),
  actor_id   uuid NOT NULL REFERENCES users,
  note_enc   text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clinical_care_plan_entries_plan ON clinical_care_plan_entries (plan_id, created_at, id);

CREATE OR REPLACE FUNCTION clinical_care_plan_version_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'published care plan versions are never deleted' USING ERRCODE = 'check_violation'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' AND (NEW.body_enc IS DISTINCT FROM OLD.body_enc OR NEW.version_no <> OLD.version_no OR NEW.plan_id <> OLD.plan_id OR NEW.published_at IS DISTINCT FROM OLD.published_at OR NEW.published_by IS DISTINCT FROM OLD.published_by
      OR NEW.status NOT IN (OLD.status, 'superseded') OR (OLD.status = 'superseded' AND NEW.status <> 'superseded')) THEN
    RAISE EXCEPTION 'published care plan versions are immutable; publish a new version instead' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS clinical_care_plan_version_guard ON clinical_care_plan_versions;
CREATE TRIGGER clinical_care_plan_version_guard BEFORE UPDATE OR DELETE ON clinical_care_plan_versions FOR EACH ROW EXECUTE FUNCTION clinical_care_plan_version_guard();

CREATE OR REPLACE FUNCTION clinical_care_plan_entries_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'clinical_care_plan_entries is append-only' USING ERRCODE = 'check_violation'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS clinical_care_plan_entries_append_only ON clinical_care_plan_entries;
CREATE TRIGGER clinical_care_plan_entries_append_only BEFORE UPDATE OR DELETE ON clinical_care_plan_entries FOR EACH ROW EXECUTE FUNCTION clinical_care_plan_entries_append_only();
