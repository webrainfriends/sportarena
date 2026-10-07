-- Player module: richer per-sport profiles (one default that always lists first) and per-match performance.

ALTER TABLE sport_profiles
  ADD COLUMN is_default       boolean NOT NULL DEFAULT false,
  ADD COLUMN jersey_no        int CHECK (jersey_no BETWEEN 0 AND 999),
  ADD COLUMN club             text,
  ADD COLUMN experience_years int CHECK (experience_years BETWEEN 0 AND 80),
  ADD COLUMN created_at       timestamptz NOT NULL DEFAULT now();

-- existing users: their oldest profile becomes the default
UPDATE sport_profiles p SET is_default = true
 WHERE p.id = (SELECT id FROM sport_profiles x WHERE x.user_id = p.user_id ORDER BY x.created_at, x.id LIMIT 1);

-- at most one default per user
CREATE UNIQUE INDEX sport_profiles_one_default ON sport_profiles (user_id) WHERE is_default;

CREATE TABLE player_matches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  sport_profile_id uuid NOT NULL REFERENCES sport_profiles ON DELETE CASCADE,
  played_on        date NOT NULL,
  opponent         text,
  venue            text,
  competition      text,
  result           text CHECK (result IN ('win','draw','loss')),
  score_for        numeric,
  score_against    numeric,
  minutes          int CHECK (minutes BETWEEN 0 AND 1000),
  rating           numeric(3,1) CHECK (rating BETWEEN 0 AND 10),
  notes            text,
  stats            jsonb NOT NULL DEFAULT '{}'::jsonb,   -- sport-specific numbers, e.g. {"goals":2,"assists":1}
  source           text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import')),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX player_matches_profile ON player_matches (sport_profile_id, played_on DESC);
CREATE INDEX player_matches_user ON player_matches (user_id, played_on DESC);
