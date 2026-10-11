-- The kind of match an athlete logged (singles, doubles, T20 …). Additive: existing rows keep NULL.
ALTER TABLE player_matches ADD COLUMN IF NOT EXISTS match_type text;
