-- Player-owned goals and self-directed training (issue #325). Additive only; nothing is deleted or cascaded.
-- The athlete owns these rows. A coach sees one only while a live share exists, and anything a coach writes about it
-- (assessments) or builds from it (adoptions) lives in its own rows, so the athlete's original wording is never rewritten.

CREATE TABLE player_goals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users,
  sport_id    uuid REFERENCES sports,
  title       text NOT NULL CHECK (length(title) BETWEEN 2 AND 160),
  category    text NOT NULL DEFAULT 'technical' CHECK (category IN ('technical','tactical','physical','mental_performance','teamwork','match_objective','custom')),
  why         text CHECK (length(why) <= 1000),
  measure     text CHECK (length(measure) <= 1000),         -- how the athlete will know
  target_value numeric,
  unit        text CHECK (length(unit) BETWEEN 1 AND 20),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','achieved','dropped')),  -- always the athlete's own claim
  starts_on   date,
  review_on   date,
  ends_on     date,
  review_cadence_days int CHECK (review_cadence_days BETWEEN 1 AND 365),
  claimed_at  timestamptz,
  client_key  text,
  row_version int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((target_value IS NULL) OR (unit IS NOT NULL)),
  CHECK (starts_on IS NULL OR ends_on IS NULL OR ends_on >= starts_on)
);
CREATE UNIQUE INDEX player_goals_key ON player_goals (owner_id, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX player_goals_owner ON player_goals (owner_id, status, review_on);

CREATE TABLE player_goal_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id     uuid NOT NULL REFERENCES player_goals,
  from_status text,
  to_status   text NOT NULL,
  note        text CHECK (length(note) <= 1000),
  by_user     uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX player_goal_events_goal ON player_goal_events (goal_id, created_at);

-- Progress is append-only and always the athlete's own report.
CREATE TABLE player_goal_progress (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id    uuid NOT NULL REFERENCES player_goals,
  value      numeric,
  note       text CHECK (length(note) <= 1000),
  logged_on  date NOT NULL DEFAULT current_date,
  client_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (value IS NOT NULL OR note IS NOT NULL)
);
CREATE UNIQUE INDEX player_goal_progress_key ON player_goal_progress (goal_id, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX player_goal_progress_goal ON player_goal_progress (goal_id, logged_on, created_at);

CREATE TABLE player_plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users,
  sport_id    uuid REFERENCES sports,
  goal_id     uuid REFERENCES player_goals,
  title       text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  intent      text CHECK (length(intent) <= 1000),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed','dropped')),
  starts_on   date,
  review_on   date,
  ends_on     date,
  client_key  text,
  row_version int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_on IS NULL OR ends_on IS NULL OR ends_on >= starts_on)
);
CREATE UNIQUE INDEX player_plans_key ON player_plans (owner_id, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX player_plans_owner ON player_plans (owner_id, status, updated_at);

-- Sessions the athlete scheduled for themselves; completed and skipped ones are never rewritten.
CREATE TABLE player_plan_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id      uuid NOT NULL REFERENCES player_plans,
  starts_at    timestamptz NOT NULL,
  duration_min int NOT NULL CHECK (duration_min BETWEEN 15 AND 480),
  kind         text NOT NULL CHECK (kind IN ('skill','tactical','conditioning','strength','recovery','mobility')),
  title        text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  instructions text CHECK (length(instructions) <= 2000),
  target_rpe   int CHECK (target_rpe BETWEEN 1 AND 10),
  status       text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','skipped','cancelled')),
  rpe          int CHECK (rpe BETWEEN 1 AND 10),
  note         text CHECK (length(note) <= 1000),            -- non-clinical training note
  completed_at timestamptz,
  client_key   text,
  row_version  int NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX player_plan_sessions_key ON player_plan_sessions (plan_id, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX player_plan_sessions_plan ON player_plan_sessions (plan_id, starts_at);

-- Optional, revocable sharing with one coach. Revoking keeps the row (revoked_at) so history stays intact.
CREATE TABLE player_shares (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id    uuid REFERENCES player_goals,
  plan_id    uuid REFERENCES player_plans,
  coach_id   uuid NOT NULL REFERENCES users,
  shared_by  uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users,
  CHECK (num_nonnulls(goal_id, plan_id) = 1)
);
CREATE UNIQUE INDEX player_shares_goal_live ON player_shares (goal_id, coach_id) WHERE revoked_at IS NULL AND goal_id IS NOT NULL;
CREATE UNIQUE INDEX player_shares_plan_live ON player_shares (plan_id, coach_id) WHERE revoked_at IS NULL AND plan_id IS NOT NULL;
CREATE INDEX player_shares_coach ON player_shares (coach_id, created_at) WHERE revoked_at IS NULL;

-- A coach's view of a shared goal or plan. Kept apart from the athlete's claim; append-only.
CREATE TABLE player_assessments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id    uuid REFERENCES player_goals,
  plan_id    uuid REFERENCES player_plans,
  coach_id   uuid NOT NULL REFERENCES users,
  rating     text NOT NULL CHECK (rating IN ('ahead','on_track','needs_attention','not_enough_evidence','confirmed_achieved')),
  note       text NOT NULL CHECK (length(note) BETWEEN 1 AND 1000),
  client_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(goal_id, plan_id) = 1)
);
CREATE UNIQUE INDEX player_assessments_key ON player_assessments (coach_id, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX player_assessments_goal ON player_assessments (goal_id, created_at) WHERE goal_id IS NOT NULL;
CREATE INDEX player_assessments_plan ON player_assessments (plan_id, created_at) WHERE plan_id IS NOT NULL;

-- A coach adopting a shared item makes their OWN record (coaching goal / draft training plan) that points back here.
-- The athlete's original is untouched and the coach's copy follows the normal coach-led flow (athlete still accepts a plan).
CREATE TABLE player_adoptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id          uuid REFERENCES player_goals,
  plan_id          uuid REFERENCES player_plans,
  coach_id         uuid NOT NULL REFERENCES users,
  coaching_goal_id uuid REFERENCES coaching_goals,
  training_plan_id uuid REFERENCES training_plans,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(goal_id, plan_id) = 1),
  CHECK (num_nonnulls(coaching_goal_id, training_plan_id) = 1)
);
CREATE UNIQUE INDEX player_adoptions_goal ON player_adoptions (goal_id, coach_id) WHERE goal_id IS NOT NULL;
CREATE UNIQUE INDEX player_adoptions_plan ON player_adoptions (plan_id, coach_id) WHERE plan_id IS NOT NULL;
