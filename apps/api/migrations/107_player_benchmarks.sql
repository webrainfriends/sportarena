-- Player benchmarks (issue #321). Additive only: indexes that keep cohort reads fast. No data is changed, moved or removed.
CREATE INDEX IF NOT EXISTS player_matches_profile_type ON player_matches (sport_profile_id, match_type) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS performances_approved_metric ON performances (sport_id, metric, user_id) WHERE provenance = 'approved_competition' AND status = 'approved';
