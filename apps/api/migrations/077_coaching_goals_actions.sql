-- Coaching goals, evidence, rubrics, measurements and actions (issue #269, slice 2). Additive only; nothing is deleted.
-- Goals reference evidence (observations, sessions, measurements, fixtures) instead of copying it. Achievement is always a coach decision.
CREATE TABLE coaching_goals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id    uuid NOT NULL REFERENCES users,
  athlete_id  uuid REFERENCES users,
  team_id     uuid REFERENCES teams,
  sport_id    uuid REFERENCES sports,
  plan_id     uuid REFERENCES training_plans,
  title       text NOT NULL CHECK (length(title) BETWEEN 2 AND 160),
  category    text NOT NULL DEFAULT 'technical' CHECK (category IN ('technical','tactical','physical','mental_performance','teamwork','match_objective','custom')),
  criterion   text CHECK (length(criterion) <= 1000),
  baseline    text CHECK (length(baseline) <= 1000),
  priority    text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
  status      text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','achieved','paused','stopped')),
  starts_on   date,
  review_on   date,
  ends_on     date,
  review_cadence_days int CHECK (review_cadence_days BETWEEN 1 AND 365),
  athlete_text text CHECK (length(athlete_text) <= 1000),  -- wording the athlete may see; NULL = not shared
  coach_notes text CHECK (length(coach_notes) <= 2000),
  achieved_at timestamptz,
  row_version int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (athlete_id IS NOT NULL OR team_id IS NOT NULL)
);
CREATE INDEX coaching_goals_athlete ON coaching_goals (athlete_id, status);
CREATE INDEX coaching_goals_team ON coaching_goals (team_id, status);
CREATE INDEX coaching_goals_coach_review ON coaching_goals (coach_id, review_on) WHERE status IN ('planned','active');

CREATE TABLE coaching_goal_events (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id   uuid NOT NULL REFERENCES coaching_goals,
  from_status text,
  to_status text NOT NULL,
  note      text CHECK (length(note) <= 1000),
  by_user   uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX coaching_goal_events_goal ON coaching_goal_events (goal_id, created_at);

-- Coach-entered numeric measurements with an explicit unit, always labelled as coach-entered.
CREATE TABLE coaching_measurements (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id   uuid NOT NULL REFERENCES users,
  athlete_id uuid NOT NULL REFERENCES users,
  sport_id   uuid REFERENCES sports,
  session_record_id uuid REFERENCES coaching_session_records,
  metric     text NOT NULL CHECK (length(metric) BETWEEN 2 AND 60),
  unit       text NOT NULL CHECK (length(unit) BETWEEN 1 AND 20),
  value      numeric NOT NULL,
  higher_is_better boolean,           -- NULL = target-range / not directional
  measured_on date NOT NULL DEFAULT current_date,
  note       text CHECK (length(note) <= 500),
  client_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX coaching_measurements_key ON coaching_measurements (coach_id, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX coaching_measurements_athlete ON coaching_measurements (athlete_id, metric, measured_on);

CREATE TABLE coaching_goal_evidence (
  goal_id       uuid NOT NULL REFERENCES coaching_goals,
  evidence_type text NOT NULL CHECK (evidence_type IN ('observation','session_record','training_session','measurement','fixture')),
  evidence_id   text NOT NULL,
  note          text CHECK (length(note) <= 500),
  added_by      uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (goal_id, evidence_type, evidence_id)
);

-- Versioned rubrics: a score keeps the version it was given under.
CREATE TABLE coaching_rubrics (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id    uuid NOT NULL REFERENCES users,
  sport_id    uuid REFERENCES sports,
  name        text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE coaching_rubric_versions (
  rubric_id  uuid NOT NULL REFERENCES coaching_rubrics,
  version    int NOT NULL,
  dimensions jsonb NOT NULL,   -- [{key,name,description,scale_min,scale_max,labels,direction}]
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rubric_id, version)
);
ALTER TABLE coaching_observations
  ADD COLUMN rubric_id uuid REFERENCES coaching_rubrics,
  ADD COLUMN rubric_version int,
  ADD COLUMN dimension_key text,
  ADD COLUMN score numeric,
  ADD CONSTRAINT coaching_observations_rubric_all CHECK ((rubric_id IS NULL) = (score IS NULL) AND (rubric_id IS NULL) = (dimension_key IS NULL) AND (rubric_id IS NULL) = (rubric_version IS NULL));
CREATE INDEX coaching_observations_rubric ON coaching_observations (athlete_id, rubric_id, dimension_key, observed_at) WHERE rubric_id IS NOT NULL;

CREATE TABLE coaching_actions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id    uuid NOT NULL REFERENCES users,
  athlete_id  uuid REFERENCES users,
  team_id     uuid REFERENCES teams,
  owner_id    uuid NOT NULL REFERENCES users,
  title       text NOT NULL CHECK (length(title) BETWEEN 2 AND 160),
  detail      text CHECK (length(detail) <= 1000),
  due_at      timestamptz,
  priority    text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','cancelled')),
  shared      boolean NOT NULL DEFAULT false,   -- an athlete-owned action is visible to the athlete only when deliberately shared
  follow_up_next_session boolean NOT NULL DEFAULT false,
  session_record_id uuid REFERENCES coaching_session_records,
  observation_id uuid REFERENCES coaching_observations,
  goal_id     uuid REFERENCES coaching_goals,
  completion_note text CHECK (length(completion_note) <= 1000),
  completed_at timestamptz,
  client_key  text,
  row_version int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (athlete_id IS NOT NULL OR team_id IS NOT NULL)
);
CREATE UNIQUE INDEX coaching_actions_key ON coaching_actions (coach_id, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX coaching_actions_open ON coaching_actions (coach_id, due_at) WHERE status IN ('open','in_progress');
CREATE INDEX coaching_actions_athlete ON coaching_actions (athlete_id, status);
