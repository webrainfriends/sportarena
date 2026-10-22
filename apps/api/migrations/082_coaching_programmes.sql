-- Coaching completion, part D (issue #269). Additive only.
-- A programme is the longitudinal frame (season / term / block) that goals belong to. It does not replace shared training plans:
-- it may reference one accepted plan, and goals keep their own links to plans, observations and evidence.
CREATE TABLE coaching_programmes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id    uuid NOT NULL REFERENCES users,
  athlete_id  uuid REFERENCES users,
  team_id     uuid REFERENCES teams,
  sport_id    uuid REFERENCES sports,
  plan_id     uuid REFERENCES training_plans,
  kind        text NOT NULL DEFAULT 'season' CHECK (kind IN ('season','term','block','programme')),
  title       text NOT NULL CHECK (length(title) BETWEEN 2 AND 160),
  objective   text CHECK (length(objective) <= 1000),
  position    text CHECK (length(position) <= 60),
  starts_on   date NOT NULL,
  review_on   date,
  ends_on     date NOT NULL,
  review_cadence_days int CHECK (review_cadence_days BETWEEN 1 AND 365),
  status      text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','completed','paused','stopped')),
  coach_notes text CHECK (length(coach_notes) <= 2000),
  athlete_text text CHECK (length(athlete_text) <= 1000),
  row_version int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (athlete_id IS NOT NULL OR team_id IS NOT NULL),
  CHECK (ends_on >= starts_on)
);
CREATE INDEX coaching_programmes_coach ON coaching_programmes (coach_id, status, starts_on DESC);
CREATE INDEX coaching_programmes_athlete ON coaching_programmes (athlete_id);
CREATE INDEX coaching_programmes_team ON coaching_programmes (team_id);
ALTER TABLE coaching_goals ADD COLUMN programme_id uuid REFERENCES coaching_programmes, ADD COLUMN position text;
CREATE INDEX coaching_goals_programme ON coaching_goals (programme_id) WHERE programme_id IS NOT NULL;
-- Rubrics can be limited to the positions they make sense for (positions are the free-text ones teams already record). Empty = every position.
ALTER TABLE coaching_rubrics ADD COLUMN positions text[] NOT NULL DEFAULT '{}';
