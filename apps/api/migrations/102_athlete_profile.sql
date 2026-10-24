-- Complete athlete profile (issue #310, item 1). Additive only: nothing is dropped, narrowed or rewritten.
--  * sport cards can be archived/restored instead of deleted, so logged career history survives
--  * dominant side, several positions, playing preferences and a per-field sharing scope
--  * opt-in dated measurements with units, provenance, scope and revocation (value encrypted)
ALTER TABLE sport_profiles ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE sport_profiles ADD COLUMN IF NOT EXISTS dominant_side text CHECK (dominant_side IN ('left','right','both'));
ALTER TABLE sport_profiles ADD COLUMN IF NOT EXISTS positions text[] NOT NULL DEFAULT '{}';
ALTER TABLE sport_profiles ADD COLUMN IF NOT EXISTS play_prefs text[] NOT NULL DEFAULT '{}';
-- who may see each new field: private (default) | coach | recruiter | public
ALTER TABLE sport_profiles ADD COLUMN IF NOT EXISTS field_scopes jsonb NOT NULL DEFAULT '{}';
-- the single position becomes the first of the positions list (the old column stays authoritative for old readers)
UPDATE sport_profiles SET positions = ARRAY[btrim(position)] WHERE positions = '{}' AND position IS NOT NULL AND btrim(position) <> '';
CREATE INDEX IF NOT EXISTS sport_profiles_archived ON sport_profiles(user_id) WHERE archived_at IS NOT NULL;

-- Everything that presents or searches a card reads this view; archived cards drop out exactly as deleted ones used to,
-- while their matches and official history stay in place. (Columns are fixed at creation: extend the view with new columns.)
CREATE OR REPLACE VIEW active_sport_profiles AS SELECT * FROM sport_profiles WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS athlete_measurements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users,
  sport_profile_id uuid NOT NULL REFERENCES sport_profiles,
  metric           text NOT NULL,
  unit             text NOT NULL CHECK (length(unit) BETWEEN 1 AND 12),
  value_enc        text NOT NULL,
  measured_on      date NOT NULL,
  source           text NOT NULL DEFAULT 'self' CHECK (source IN ('self','coach','test')),
  note             text,
  scope            text NOT NULL DEFAULT 'private' CHECK (scope IN ('private','coach','recruiter','public')),
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS athlete_measurements_profile ON athlete_measurements(sport_profile_id, metric, measured_on DESC, id);
