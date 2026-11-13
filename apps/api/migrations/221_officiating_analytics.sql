-- Officiating analytics and season intelligence (REF-R27 / issue #1025).
-- Additive only. Two new tables for pre-aggregated stats.
-- No existing tables are dropped, truncated or narrowed.

CREATE TABLE IF NOT EXISTS official_season_summaries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id),
  sport_id        uuid NOT NULL REFERENCES sports(id),
  season_label    text NOT NULL,
  season_from     date NOT NULL,
  season_to       date NOT NULL,
  total_games     int NOT NULL DEFAULT 0,
  total_hours     numeric(8,2) NOT NULL DEFAULT 0,
  accepted_count  int NOT NULL DEFAULT 0,
  declined_count  int NOT NULL DEFAULT 0,
  cancelled_count int NOT NULL DEFAULT 0,
  avg_fee_minor   int,
  fee_currency    text,
  utilisation_pct numeric(5,2),
  repeat_client_count int NOT NULL DEFAULT 0,
  incident_count  int NOT NULL DEFAULT 0,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, sport_id, season_label)
);
CREATE INDEX IF NOT EXISTS off_season_sum_user_idx  ON official_season_summaries(user_id);
CREATE INDEX IF NOT EXISTS off_season_sum_sport_idx ON official_season_summaries(sport_id, season_label);

CREATE TABLE IF NOT EXISTS officiating_analytics_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type      text NOT NULL CHECK (scope_type IN ('official','organisation','event')),
  scope_id        uuid NOT NULL,
  snapshot_date   date NOT NULL,
  sport_id        uuid REFERENCES sports(id),
  role            text,
  level           text,
  games_count     int NOT NULL DEFAULT 0,
  hours_total     numeric(8,2) NOT NULL DEFAULT 0,
  accepted_count  int NOT NULL DEFAULT 0,
  declined_count  int NOT NULL DEFAULT 0,
  cancelled_count int NOT NULL DEFAULT 0,
  incident_count  int NOT NULL DEFAULT 0,
  fee_minor_total bigint NOT NULL DEFAULT 0,
  fee_currency    text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS off_analytics_snap_unique_idx
  ON officiating_analytics_snapshots(scope_type, scope_id, snapshot_date,
     COALESCE(sport_id, '00000000-0000-0000-0000-000000000000'::uuid),
     COALESCE(role,''), COALESCE(level,''));
CREATE INDEX IF NOT EXISTS off_analytics_snap_scope_idx
  ON officiating_analytics_snapshots(scope_type, scope_id, snapshot_date);
