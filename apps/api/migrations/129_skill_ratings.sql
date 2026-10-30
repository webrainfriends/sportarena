-- Skill ratings (#633). Additive only: new tables, nothing existing is changed or removed.
-- A rating is a projection of verified results (published score sheets, completed event sessions). It never creates a result.
-- Every recompute is a run; a run's per-game changes are kept, so "why did my level move" stays answerable after a correction.
-- Rollback: nothing reads these tables except the rating capabilities and the open-game level lookup, which falls back to the stated level.

CREATE TABLE IF NOT EXISTS skill_rating_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport_id    uuid NOT NULL REFERENCES sports,
  input_hash  text NOT NULL,                      -- hash of the evidence replayed; an unchanged hash never writes a new run
  games_n     int  NOT NULL CHECK (games_n >= 0),
  players_n   int  NOT NULL CHECK (players_n >= 0),
  model       text NOT NULL,                      -- the family model used (racket, goal_game, cricket, measured, generic)
  reason      text NOT NULL DEFAULT 'sweep' CHECK (reason IN ('sweep','correction','manual','first')),
  created_by  uuid REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS skill_rating_runs_sport ON skill_rating_runs (sport_id, created_at DESC);

-- Current rating per person and sport. 'void' (never a delete) marks someone whose evidence no longer stands after a correction.
CREATE TABLE IF NOT EXISTS skill_ratings (
  sport_id       uuid NOT NULL REFERENCES sports,
  user_id        uuid NOT NULL REFERENCES users,
  rating         numeric(8,2) NOT NULL,
  rd             numeric(8,2) NOT NULL,
  sigma          numeric(8,4) NOT NULL,
  games          int NOT NULL DEFAULT 0,
  wins           int NOT NULL DEFAULT 0,
  losses         int NOT NULL DEFAULT 0,
  draws          int NOT NULL DEFAULT 0,
  peak_rating    numeric(8,2) NOT NULL,
  last_played_at timestamptz,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
  run_id         uuid NOT NULL REFERENCES skill_rating_runs,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sport_id, user_id)
);
CREATE INDEX IF NOT EXISTS skill_ratings_user ON skill_ratings (user_id) WHERE status = 'active';

-- One row per person per game per run: the evidence behind every move of the level.
CREATE TABLE IF NOT EXISTS skill_rating_changes (
  id          bigserial PRIMARY KEY,
  run_id      uuid NOT NULL REFERENCES skill_rating_runs,
  sport_id    uuid NOT NULL REFERENCES sports,
  user_id     uuid NOT NULL REFERENCES users,
  game_kind   text NOT NULL CHECK (game_kind IN ('fixture','session')),
  game_id     uuid NOT NULL,
  event_id    uuid REFERENCES events,
  played_at   timestamptz NOT NULL,
  result      text NOT NULL CHECK (result IN ('win','loss','draw')),
  expected    numeric(6,4) NOT NULL,
  before_r    numeric(8,2) NOT NULL,
  before_rd   numeric(8,2) NOT NULL,
  after_r     numeric(8,2) NOT NULL,
  after_rd    numeric(8,2) NOT NULL,
  opponent_r  numeric(8,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS skill_rating_changes_player ON skill_rating_changes (run_id, user_id, played_at);
CREATE INDEX IF NOT EXISTS skill_rating_changes_user ON skill_rating_changes (user_id, sport_id, run_id);
