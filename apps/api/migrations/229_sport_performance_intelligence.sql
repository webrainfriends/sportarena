-- Sport-Specific Performance Intelligence (issue #506)
-- Additive only: two new tables. Never drops, truncates or rewrites existing data.

-- Context split entries: athlete's performance split by a context dimension (computed at read time, cached here).
-- Columns are canonical strings not foreign keys so the cache survives a deletion/rename upstream without orphaned rows.
CREATE TABLE IF NOT EXISTS sport_perf_context_entries (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid        NOT NULL REFERENCES users(id),
  sport_id            uuid        NOT NULL REFERENCES sports(id),
  dimension           text        NOT NULL,
  dimension_value     text        NOT NULL,
  dimension_label     text        NOT NULL,
  metric              text        NOT NULL,
  value               numeric     NOT NULL,
  unit                text,
  direction           text        NOT NULL DEFAULT 'higher',
  evidence            text        NOT NULL,
  sample_size         integer     NOT NULL DEFAULT 1,
  source_fixture_ids  uuid[]      NOT NULL DEFAULT '{}',
  calc_version        text        NOT NULL,
  computed_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT spi_context_dim   CHECK (dimension IN ('opponent','venue','competition','format','surface','position')),
  CONSTRAINT spi_context_evid  CHECK (evidence IN ('approved_competition','self_reported','imported','combined'))
);
CREATE INDEX IF NOT EXISTS sport_perf_context_entries_user_sport_dim ON sport_perf_context_entries (user_id, sport_id, dimension);
CREATE INDEX IF NOT EXISTS sport_perf_context_entries_user_sport_met ON sport_perf_context_entries (user_id, sport_id, metric);

-- Frozen analytics snapshots: when an athlete pins a snapshot to their passport, the full result with provenance is frozen here.
-- The calc_version column lets historical report/passport snapshots reproduce the exact calculation that was used.
CREATE TABLE IF NOT EXISTS sport_perf_passport_snapshots (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES users(id),
  sport_id        uuid        NOT NULL REFERENCES sports(id),
  snapshot_label  text        NOT NULL,
  calc_version    text        NOT NULL,
  sport_slug      text        NOT NULL,
  payload         jsonb       NOT NULL,
  provenance      jsonb       NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
);
CREATE INDEX IF NOT EXISTS sport_perf_passport_snapshots_user_sport ON sport_perf_passport_snapshots (user_id, sport_id) WHERE archived_at IS NULL;
