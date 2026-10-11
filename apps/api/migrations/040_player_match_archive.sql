-- Logged matches are archived, not deleted (data is never removed). Additive: existing rows keep archived_at NULL and behave as before.
ALTER TABLE player_matches ADD COLUMN IF NOT EXISTS archived_at timestamptz;
CREATE INDEX IF NOT EXISTS player_matches_live ON player_matches (user_id, played_on DESC) WHERE archived_at IS NULL;
