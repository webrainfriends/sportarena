-- Issue #1211: Fix schema/column mismatches between 226_selection_campaigns.sql and
-- the selection capability files. Additive only — no data is dropped.

-- selection_campaigns: add columns referenced by capability code but absent from migration 226
ALTER TABLE selection_campaigns ADD COLUMN IF NOT EXISTS row_version int NOT NULL DEFAULT 1;
ALTER TABLE selection_campaigns ADD COLUMN IF NOT EXISTS criteria_locked_at timestamptz;
ALTER TABLE selection_campaigns ADD COLUMN IF NOT EXISTS target_squad_size int;
ALTER TABLE selection_campaigns ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
  CHECK (status IN ('active','completed','archived','cancelled'));
ALTER TABLE selection_campaigns ADD COLUMN IF NOT EXISTS season_label text;
ALTER TABLE selection_campaigns ADD COLUMN IF NOT EXISTS competition_id uuid REFERENCES events;

-- selection_nominations: capability code queries user_id but migration created candidate_id
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='selection_nominations' AND column_name='candidate_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='selection_nominations' AND column_name='user_id'
  ) THEN
    ALTER TABLE selection_nominations RENAME COLUMN candidate_id TO user_id;
  END IF;
END $$;

-- selection_assessments: capability code uses observation_notes_enc and confidence
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='selection_assessments' AND column_name='observations_enc'
  ) THEN
    ALTER TABLE selection_assessments RENAME COLUMN observations_enc TO observation_notes_enc;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='selection_assessments' AND column_name='confidence_score'
  ) THEN
    ALTER TABLE selection_assessments RENAME COLUMN confidence_score TO confidence;
  END IF;
END $$;

-- selection_policy_versions: capability code orders by version_number; add generated alias
ALTER TABLE selection_policy_versions
  ADD COLUMN IF NOT EXISTS version_number int GENERATED ALWAYS AS (version) STORED;

-- selection_recommendations: capability code uses version_number for inserts and ordering
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='selection_recommendations' AND column_name='version'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='selection_recommendations' AND column_name='version_number'
  ) THEN
    ALTER TABLE selection_recommendations RENAME COLUMN version TO version_number;
  END IF;
END $$;
ALTER TABLE selection_recommendations ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- selection_roster_publications: add recommendation_id and published_by referenced in
-- publish_selection_roster capability
ALTER TABLE selection_roster_publications
  ADD COLUMN IF NOT EXISTS recommendation_id uuid REFERENCES selection_recommendations;
ALTER TABLE selection_roster_publications
  ADD COLUMN IF NOT EXISTS published_by uuid REFERENCES users;

-- selection_appeals: capability code references nomination_id
ALTER TABLE selection_appeals
  ADD COLUMN IF NOT EXISTS nomination_id uuid REFERENCES selection_nominations;

-- selection_approval_routes: approval-inbox.js reads approver_name and last_decision;
-- approval capability's get_decision_pack JOINs on decided_by in decisions table
ALTER TABLE selection_approval_routes
  ADD COLUMN IF NOT EXISTS approver_name text;
ALTER TABLE selection_approval_routes
  ADD COLUMN IF NOT EXISTS last_decision text;

-- selection_approval_decisions: get_decision_pack JOINs users on decided_by but migration
-- has approver_id — add decided_by as a generated alias
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='selection_approval_decisions' AND column_name='approver_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='selection_approval_decisions' AND column_name='decided_by'
  ) THEN
    ALTER TABLE selection_approval_decisions ADD COLUMN decided_by uuid;
    UPDATE selection_approval_decisions SET decided_by = approver_id;
    ALTER TABLE selection_approval_decisions ALTER COLUMN decided_by SET NOT NULL;
  END IF;
END $$;

-- selection_committee_reviews: add recommendation_id referenced in submit_committee_review
ALTER TABLE selection_committee_reviews
  ADD COLUMN IF NOT EXISTS recommendation_id uuid REFERENCES selection_recommendations;

-- New table: organisation selection policies (for selection-policy-builder screen)
CREATE TABLE IF NOT EXISTS selection_org_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations,
  name text NOT NULL,
  version_number int NOT NULL DEFAULT 1,
  approval_chain jsonb NOT NULL DEFAULT '[]',
  sod_rules jsonb NOT NULL DEFAULT '{}',
  sport_templates jsonb NOT NULL DEFAULT '{}',
  delegation_rules jsonb NOT NULL DEFAULT '{}',
  effective_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES users,
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS selop_org ON selection_org_policies (org_id) WHERE superseded_at IS NULL;

-- selection_comparison_scenarios: capability code inserts label/position/notes_enc
-- but migration has name and no position/notes_enc columns
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='selection_comparison_scenarios' AND column_name='name'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='selection_comparison_scenarios' AND column_name='label'
  ) THEN
    ALTER TABLE selection_comparison_scenarios RENAME COLUMN name TO label;
  END IF;
END $$;
ALTER TABLE selection_comparison_scenarios ADD COLUMN IF NOT EXISTS position text;
ALTER TABLE selection_comparison_scenarios ADD COLUMN IF NOT EXISTS notes_enc text;

-- selection_audit_events: submit_selection_assessment inserts nomination_id but it's absent
ALTER TABLE selection_audit_events ADD COLUMN IF NOT EXISTS nomination_id uuid REFERENCES selection_nominations;

-- Index to accelerate outcomes review query
CREATE INDEX IF NOT EXISTS selfr_model ON selection_forecast_runs (campaign_id, run_at DESC);
