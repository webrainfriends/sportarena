-- Coaching reports (issue #269, slice 4). Additive only. A report is an editable definition (what to include, for whom, in which words);
-- publishing freezes an immutable, numbered snapshot built on the server. Later changes to notes, goals or metrics never alter an issued version.
CREATE TABLE coaching_reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id    uuid NOT NULL REFERENCES users,
  athlete_id  uuid REFERENCES users,
  team_id     uuid REFERENCES teams,
  kind        text NOT NULL DEFAULT 'athlete_progress' CHECK (kind IN ('session','athlete_progress','goal_review','team_training','match_debrief','period_review','action_summary')),
  title       text NOT NULL CHECK (length(title) BETWEEN 2 AND 160),
  audience    text NOT NULL DEFAULT 'coach_private' CHECK (audience IN ('coach_private','athlete','guardian','team_staff')),
  period_from date NOT NULL,
  period_to   date NOT NULL,
  selection   jsonb NOT NULL DEFAULT '{}',   -- {goals, metrics, actions, observation_ids[], session_record_ids[]}: references, never copies
  narrative   text CHECK (length(narrative) <= 6000),
  narrative_from_ai boolean NOT NULL DEFAULT false,
  ai_draft_id uuid REFERENCES coaching_ai_drafts,
  latest_version int NOT NULL DEFAULT 0,
  row_version int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (athlete_id IS NOT NULL OR team_id IS NOT NULL),
  CHECK (period_to >= period_from),
  CHECK (audience <> 'team_staff' OR team_id IS NOT NULL),
  CHECK (audience <> 'guardian' OR athlete_id IS NOT NULL),
  CHECK (audience <> 'athlete' OR athlete_id IS NOT NULL)
);
CREATE INDEX coaching_reports_coach ON coaching_reports (coach_id, updated_at DESC);
CREATE INDEX coaching_reports_athlete ON coaching_reports (athlete_id);

CREATE TABLE coaching_report_versions (
  report_id    uuid NOT NULL REFERENCES coaching_reports,
  version      int NOT NULL,
  audience     text NOT NULL,
  snapshot     jsonb NOT NULL,
  snapshot_sha256 text NOT NULL,
  published_by uuid NOT NULL REFERENCES users,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, version)
);
CREATE FUNCTION coaching_report_versions_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'coaching_report_versions are immutable: publish a new version instead'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER coaching_report_versions_immutable BEFORE UPDATE OR DELETE ON coaching_report_versions FOR EACH ROW EXECUTE FUNCTION coaching_report_versions_immutable();

-- A generated PDF can now say which published report version it was made from. Existing rows keep NULL.
ALTER TABLE generated_documents ADD COLUMN source_version int;
