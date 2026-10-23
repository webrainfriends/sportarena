-- Application scoring and evaluation committees (#288). Extends the programs / rounds / applications of #284-#285; purely additive and
-- backwards-compatible. Nothing is dropped, rewritten or deleted; no ON DELETE CASCADE; rows are voided / cleared / retired, never deleted.
-- Rollback = deploy the previous code: the new columns have defaults and the new tables are simply unused. Programs without a rubric
-- behave exactly as before (award / decline need no scoring), so every existing program, application and agreement is unchanged.

-- Where an application stands in evaluation. 'received' is every existing application.
ALTER TABLE sponsorship_applications ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'received';
DO $$ BEGIN
  ALTER TABLE sponsorship_applications ADD CONSTRAINT sponsorship_applications_stage_chk CHECK (stage IN ('received','shortlisted','interview','finalist'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE sponsorship_applications ADD COLUMN IF NOT EXISTS eval_version int NOT NULL DEFAULT 1; -- bumped by every evaluation change, for stale-version checks

-- One weighted rubric per round (a locked rubric is never edited, so every score is always against the criteria it was made under).
CREATE TABLE IF NOT EXISTS sponsorship_rubrics (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id          uuid NOT NULL REFERENCES sponsorship_rounds,
  version           int  NOT NULL DEFAULT 1,
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','retired')),
  anonymize         boolean NOT NULL DEFAULT true,   -- applicant identity stays hidden from the committee until the applicant consents
  scale_max         int  NOT NULL DEFAULT 5 CHECK (scale_max BETWEEN 2 AND 10),
  spread_threshold  int  NOT NULL DEFAULT 20 CHECK (spread_threshold BETWEEN 1 AND 100), -- reviewer disagreement (points of 100) that asks for moderation
  scoring_closes_at timestamptz,
  created_by        uuid NOT NULL REFERENCES users,
  activated_at      timestamptz,
  locked_at         timestamptz,                     -- set by the first submitted score; criteria and weights are frozen from then on
  row_version       int  NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (round_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS sponsorship_rubrics_live ON sponsorship_rubrics (round_id) WHERE status IN ('draft','active');

CREATE TABLE IF NOT EXISTS sponsorship_rubric_criteria (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rubric_id   uuid NOT NULL REFERENCES sponsorship_rubrics,
  position    int  NOT NULL CHECK (position >= 0),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description text CHECK (description IS NULL OR length(description) <= 500),
  weight      int  NOT NULL CHECK (weight BETWEEN 1 AND 100),  -- the weights of a rubric total exactly 100 (checked when saved and when activated)
  UNIQUE (rubric_id, position)
);

-- The committee of a round: reviewers score, moderators also resolve disagreement and move applications between stages.
CREATE TABLE IF NOT EXISTS sponsorship_reviewers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id   uuid NOT NULL REFERENCES sponsorship_rounds,
  user_id    uuid NOT NULL REFERENCES users,
  role       text NOT NULL DEFAULT 'reviewer' CHECK (role IN ('reviewer','moderator')),
  added_by   uuid NOT NULL REFERENCES users,
  removed_at timestamptz,
  removed_by uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sponsorship_reviewers_live ON sponsorship_reviewers (round_id, user_id) WHERE removed_at IS NULL;

-- Conflict of interest / recusal. A conflicted reviewer cannot score that application (also detected automatically from ownership and team membership).
CREATE TABLE IF NOT EXISTS sponsorship_conflicts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   uuid NOT NULL REFERENCES sponsorship_applications,
  reviewer_user_id uuid NOT NULL REFERENCES users,
  source           text NOT NULL CHECK (source IN ('self','manager')),
  reason           text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  declared_by      uuid NOT NULL REFERENCES users,
  cleared_at       timestamptz,
  cleared_by       uuid REFERENCES users,
  clear_reason     text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sponsorship_conflicts_live ON sponsorship_conflicts (application_id, reviewer_user_id) WHERE cleared_at IS NULL;

-- Confidential: read only by the brand's evaluation staff, never by applicants, never in applicant-facing endpoints.
CREATE TABLE IF NOT EXISTS sponsorship_scores (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   uuid NOT NULL REFERENCES sponsorship_applications,
  rubric_id        uuid NOT NULL REFERENCES sponsorship_rubrics,
  reviewer_user_id uuid NOT NULL REFERENCES users,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','voided')),
  criteria         jsonb NOT NULL DEFAULT '[]',      -- [{ criterion_id, score, comment }]
  comment          text CHECK (comment IS NULL OR length(comment) <= 2000),
  total            numeric(5,2) CHECK (total IS NULL OR total BETWEEN 0 AND 100), -- weighted, out of 100
  row_version      int NOT NULL DEFAULT 1,
  submitted_at     timestamptz,
  voided_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, reviewer_user_id),
  CHECK (status <> 'submitted' OR (total IS NOT NULL AND submitted_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS sponsorship_scores_application ON sponsorship_scores (application_id, status);

-- Append-only: the moderated total replaces the reviewers' average as the final score; every adjustment and its reason stays on record.
CREATE TABLE IF NOT EXISTS sponsorship_moderations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES sponsorship_applications,
  total          numeric(5,2) NOT NULL CHECK (total BETWEEN 0 AND 100),
  reason         text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  moderated_by   uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sponsorship_moderations_application ON sponsorship_moderations (application_id, created_at DESC, id);

-- Interviews: any number of rounds (seq) per application, each a scheduled time, a video link, or both, until the sponsor moves on.
CREATE TABLE IF NOT EXISTS sponsorship_interviews (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES sponsorship_applications,
  seq            int  NOT NULL CHECK (seq > 0),
  scheduled_at   timestamptz,
  timezone       text,
  video_url      text CHECK (video_url IS NULL OR video_url ~ '^https://'),
  location       text CHECK (location IS NULL OR length(location) <= 300),
  notes          text CHECK (notes IS NULL OR length(notes) <= 2000),   -- visible to the applicant
  status         text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled')),
  outcome        text CHECK (outcome IS NULL OR length(outcome) <= 2000), -- internal
  created_by     uuid NOT NULL REFERENCES users,
  row_version    int NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, seq),
  CHECK (scheduled_at IS NOT NULL OR video_url IS NOT NULL)
);

-- The consent flow: the brand asks to see who applied; only the applicant can grant (and later revoke) it.
CREATE TABLE IF NOT EXISTS sponsorship_identity_consents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES sponsorship_applications,
  requested_by   uuid NOT NULL REFERENCES users,
  message        text CHECK (message IS NULL OR length(message) <= 500),
  status         text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','granted','denied','revoked')),
  responded_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sponsorship_identity_consents_live ON sponsorship_identity_consents (application_id) WHERE status IN ('requested','granted');

-- Append-only decision history of an application (no score values: those stay in sponsorship_scores).
CREATE TABLE IF NOT EXISTS sponsorship_application_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES sponsorship_applications,
  kind           text NOT NULL,
  actor_id       uuid REFERENCES users,
  data           jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sponsorship_application_events_application ON sponsorship_application_events (application_id, created_at, id);

-- What the final decision was based on: the rubric as scored, the result, and the references the brand may rely on.
CREATE TABLE IF NOT EXISTS sponsorship_decision_records (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL UNIQUE REFERENCES sponsorship_applications,
  decision       text NOT NULL CHECK (decision IN ('award','decline')),
  rubric_id      uuid REFERENCES sponsorship_rubrics,
  rubric_snapshot jsonb,
  score_snapshot jsonb,
  source_refs    jsonb NOT NULL DEFAULT '{}',
  decided_by     uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now()
);
