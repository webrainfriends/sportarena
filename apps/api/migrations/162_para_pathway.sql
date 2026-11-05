-- Para-sport development pathways (#841). Additive and backwards-compatible.
-- No diagnosis/impairment/condition field anywhere by design: an athlete's classification
-- is an administrative sporting classification, never a medical record.
-- Rollback: every statement is idempotent; deploy the previous build to roll back.

CREATE TABLE IF NOT EXISTS para_pathway_milestones (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id       uuid NOT NULL REFERENCES users(id),
  sport            text NOT NULL,
  stage            text NOT NULL CHECK (stage IN (
    'adapted_learning',
    'coach_evaluation',
    'community_competition',
    'official_advancement',
    'verified_competition'
  )),
  title_enc        text NOT NULL,
  notes_enc        text,
  linked_goal_id               uuid REFERENCES player_goals(id),
  linked_plan_id               uuid REFERENCES player_plans(id),
  linked_academy_assessment_id uuid REFERENCES academy_assessments(id),
  linked_learning_outcome_id   uuid REFERENCES learning_outcomes(id),
  display_order    integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS para_pathway_milestones_athlete
  ON para_pathway_milestones (athlete_id, sport, stage);

CREATE TABLE IF NOT EXISTS para_pathway_evidence (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  milestone_id     uuid NOT NULL REFERENCES para_pathway_milestones(id),
  athlete_id       uuid NOT NULL REFERENCES users(id),
  provenance_label text NOT NULL,
  kind             text NOT NULL CHECK (kind IN (
    'player_goal',
    'coach_observation',
    'competition_result',
    'academy_assessment',
    'learning_outcome',
    'external_ref',
    'other'
  )),
  source_id        uuid,
  notes_enc        text,
  state            text NOT NULL DEFAULT 'submitted' CHECK (state IN (
    'submitted', 'under_review', 'approved', 'returned'
  )),
  reviewed_by      uuid REFERENCES users(id),
  reviewed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS para_pathway_evidence_milestone
  ON para_pathway_evidence (milestone_id);
CREATE INDEX IF NOT EXISTS para_pathway_evidence_athlete
  ON para_pathway_evidence (athlete_id, state);

CREATE TABLE IF NOT EXISTS para_pathway_feedback_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  milestone_id uuid NOT NULL REFERENCES para_pathway_milestones(id),
  athlete_id   uuid NOT NULL REFERENCES users(id),
  coach_id     uuid NOT NULL REFERENCES users(id),
  message_enc  text,
  state        text NOT NULL DEFAULT 'pending' CHECK (state IN (
    'pending', 'responded', 'declined'
  )),
  responded_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS para_pathway_feedback_athlete
  ON para_pathway_feedback_requests (athlete_id, coach_id);

CREATE TABLE IF NOT EXISTS para_pathway_shares (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id       uuid NOT NULL REFERENCES users(id),
  shared_with_id   uuid NOT NULL,
  shared_with_kind text NOT NULL CHECK (shared_with_kind IN ('person', 'organisation')),
  scope            text[] NOT NULL DEFAULT '{}',
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS para_pathway_shares_athlete
  ON para_pathway_shares (athlete_id)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS para_pathway_shares_with
  ON para_pathway_shares (shared_with_id, athlete_id)
  WHERE revoked_at IS NULL;
