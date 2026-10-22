-- Coaching completion, part C (issue #269). Additive only.
-- Session and block templates extend the existing coach_templates table (no second template store). A template is a private copy of
-- blocks with no player data; applying one copies the blocks into a new plan version, so later template edits never touch a session.
ALTER TABLE coach_templates
  ADD COLUMN scope text NOT NULL DEFAULT 'drill' CHECK (scope IN ('drill','block','session')),
  ADD COLUMN blocks jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN version int NOT NULL DEFAULT 1,
  ADD COLUMN shared_team_id uuid REFERENCES teams,
  ADD COLUMN shared_organisation_id uuid REFERENCES organisations,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT coach_templates_one_share CHECK (shared_team_id IS NULL OR shared_organisation_id IS NULL);
CREATE INDEX coach_templates_team ON coach_templates (shared_team_id) WHERE shared_team_id IS NOT NULL AND archived_at IS NULL;
CREATE INDEX coach_templates_org ON coach_templates (shared_organisation_id) WHERE shared_organisation_id IS NOT NULL AND archived_at IS NULL;

-- Which template (and its version) a plan version was built from, kept as a reference on the plan version itself.
ALTER TABLE coaching_session_plan_versions ADD COLUMN from_template_id uuid REFERENCES coach_templates, ADD COLUMN from_template_version int;

-- Units/groups inside one session (e.g. defenders, forwards): named sets of rostered athletes that blocks can be aimed at.
ALTER TABLE coaching_session_records ADD COLUMN groups jsonb NOT NULL DEFAULT '[]', ADD COLUMN team_summary_shared boolean NOT NULL DEFAULT false;

-- A head coach can let another coach of the same team help with one session. Permissions are explicit and checked live.
CREATE TABLE coaching_session_delegates (
  session_record_id uuid NOT NULL REFERENCES coaching_session_records,
  user_id     uuid NOT NULL REFERENCES users,
  permissions text[] NOT NULL CHECK (permissions <@ ARRAY['attendance','observe']::text[]),
  granted_by  uuid NOT NULL REFERENCES users,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  PRIMARY KEY (session_record_id, user_id)
);

-- A short summary written for one player, shown to them only when the coach shares it.
CREATE TABLE coaching_player_summaries (
  session_record_id uuid NOT NULL REFERENCES coaching_session_records,
  athlete_id  uuid NOT NULL REFERENCES users,
  summary     text NOT NULL CHECK (length(summary) BETWEEN 1 AND 2000),
  shared      boolean NOT NULL DEFAULT false,
  row_version int NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_record_id, athlete_id)
);

-- Recurring actions: finishing one schedules the next (the original stays as history).
ALTER TABLE coaching_actions ADD COLUMN recurrence_days int CHECK (recurrence_days BETWEEN 1 AND 365), ADD COLUMN recurs_from uuid REFERENCES coaching_actions;
