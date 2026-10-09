-- Shared training-plan model (coach proposes, athlete responds). One source of truth for both the
-- coach workspace and the athlete's view. Additive only; nothing here deletes or cascades user data.
CREATE TABLE training_plans (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id     uuid NOT NULL REFERENCES users,
  athlete_id   uuid NOT NULL REFERENCES users,
  sport_id     uuid REFERENCES sports,
  hire_id      uuid REFERENCES coach_hires,
  title        text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  goal         text CHECK (length(goal) <= 1000),
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','proposed','active','declined','change_requested','closed')),
  current_rev  int  NOT NULL DEFAULT 1,
  accepted_rev int,
  closed_by    uuid REFERENCES users,
  closed_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (coach_id <> athlete_id)
);
CREATE INDEX training_plans_coach ON training_plans (coach_id, status);
CREATE INDEX training_plans_athlete ON training_plans (athlete_id, status);

-- Revisions are append-only: once proposed, content never changes; only the athlete's response is recorded.
CREATE TABLE training_plan_revisions (
  plan_id       uuid NOT NULL REFERENCES training_plans,
  rev           int  NOT NULL,
  title         text NOT NULL,
  goal          text,
  content       jsonb NOT NULL DEFAULT '{"targets":[],"sessions":[]}',
  response      text NOT NULL DEFAULT 'draft' CHECK (response IN ('draft','pending','accepted','declined','change_requested','superseded')),
  response_note text CHECK (length(response_note) <= 1000),
  proposed_at   timestamptz,
  responded_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id, rev)
);

-- Sessions exist once the athlete accepts a revision; completed/skipped sessions are never rewritten.
CREATE TABLE training_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id          uuid NOT NULL REFERENCES training_plans,
  from_rev         int  NOT NULL,
  starts_at        timestamptz NOT NULL,
  duration_min     int  NOT NULL CHECK (duration_min BETWEEN 15 AND 480),
  kind             text NOT NULL CHECK (kind IN ('skill','tactical','conditioning','strength','recovery','mobility')),
  title            text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  instructions     text CHECK (length(instructions) <= 2000),
  target_rpe       int  CHECK (target_rpe BETWEEN 1 AND 10),
  booking_id       uuid REFERENCES bookings,
  status           text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','skipped','cancelled')),
  athlete_rpe      int  CHECK (athlete_rpe BETWEEN 1 AND 10),
  athlete_feedback text CHECK (length(athlete_feedback) <= 1000), -- non-clinical coaching feedback only
  coach_feedback   text CHECK (length(coach_feedback) <= 1000),
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX training_sessions_plan ON training_sessions (plan_id, starts_at);

-- Reusable drill / session structures. Never contains athlete-specific data.
CREATE TABLE coach_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id    uuid NOT NULL REFERENCES users,
  sport_id    uuid REFERENCES sports,
  title       text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  kind        text CHECK (kind IN ('skill','tactical','conditioning','strength','recovery','mobility')),
  structure   jsonb NOT NULL DEFAULT '{}',
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX coach_templates_coach ON coach_templates (coach_id) WHERE archived_at IS NULL;
