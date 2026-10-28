-- Transparent player & team rankings (#507). A ranking is a projection of verified results, never a source of truth: nothing here stores a match or
-- performance fact. Definitions are versioned and immutable (scope, formula, minimum sample, tie rules), snapshots are append-only so a rank that was
-- published last week stays reproducible after a formula change, and integrity flags only ever ask a human to look.
-- Additive and backwards-compatible: new tables only, no data is changed, dropped or rewritten. Rollback: revert the app code; the tables are inert for old code.

CREATE TABLE IF NOT EXISTS ranking_definitions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport_id        uuid NOT NULL REFERENCES sports,
  subject         text NOT NULL CHECK (subject IN ('player','team')),
  name            text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  family          text NOT NULL CHECK (family IN ('cricket','goal_game','racket','measured','team_form','generic')),
  visibility      text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','club')),
  scope_team_id   uuid REFERENCES teams,                         -- club / academy internal rankings: only this team's members see it
  status          text NOT NULL DEFAULT 'published' CHECK (status IN ('published','retired')),
  current_version int NOT NULL DEFAULT 0,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  retired_at      timestamptz,
  CHECK (visibility = 'public' OR scope_team_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ranking_definitions_sport ON ranking_definitions (sport_id, subject) WHERE status = 'published';

-- Every version says exactly how a rank is produced. Immutable: a change is a new version, and snapshots point at the version that made them.
CREATE TABLE IF NOT EXISTS ranking_definition_versions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id       uuid NOT NULL REFERENCES ranking_definitions,
  version             int NOT NULL CHECK (version >= 1),
  formula_kind        text NOT NULL CHECK (formula_kind IN ('metric','per_90','per_match','team_form')),
  metric              text,                                       -- the governed metric (players); NULL for team form
  aggregation         text NOT NULL DEFAULT 'best' CHECK (aggregation IN ('best','sum','mean','last')),
  direction           text NOT NULL CHECK (direction IN ('higher','lower')),
  evidence            text NOT NULL DEFAULT 'official' CHECK (evidence IN ('official','development')),  -- development = practice/imported allowed, never public
  min_samples         int NOT NULL CHECK (min_samples >= 1),     -- fewest eligible results (or games) to appear
  min_distinct_events int NOT NULL DEFAULT 2 CHECK (min_distinct_events >= 1), -- a single lucky event cannot make a ranking unless the scope is that event
  window_days         int CHECK (window_days IS NULL OR window_days BETWEEN 1 AND 3660),   -- form over a stated window
  window_games        int CHECK (window_games IS NULL OR window_games BETWEEN 1 AND 200),  -- team form: last N games
  scope               jsonb NOT NULL DEFAULT '{}',               -- { season, event_id, region, format, position }
  tie_rules           text NOT NULL,
  exclusions          text NOT NULL,
  formula_hash        text NOT NULL,
  note                text,
  client_key          text,
  created_by          uuid NOT NULL REFERENCES users,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (definition_id, version),
  CHECK (formula_kind = 'team_form' OR metric IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS ranking_versions_client_key ON ranking_definition_versions (definition_id, client_key) WHERE client_key IS NOT NULL;

CREATE OR REPLACE FUNCTION ranking_record_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'published ranking versions and snapshots are immutable'; END $$;
DROP TRIGGER IF EXISTS ranking_version_immutable ON ranking_definition_versions;
CREATE TRIGGER ranking_version_immutable BEFORE UPDATE OR DELETE ON ranking_definition_versions
  FOR EACH ROW EXECUTE FUNCTION ranking_record_immutable();

-- Periodic snapshots (weekly, and after a corrected result). Append-only: movement over time is read from these, never recomputed backwards.
CREATE TABLE IF NOT EXISTS ranking_snapshots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id uuid NOT NULL REFERENCES ranking_definitions,
  version_id    uuid NOT NULL REFERENCES ranking_definition_versions,
  as_of         timestamptz NOT NULL,
  reason        text NOT NULL CHECK (reason IN ('weekly','correction','manual')),
  entries_n     int NOT NULL,
  content_hash  text NOT NULL,                                   -- same evidence + same version = same hash, so a rerun does not add noise
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ranking_snapshots_def ON ranking_snapshots (definition_id, as_of DESC);
CREATE TABLE IF NOT EXISTS ranking_snapshot_entries (
  snapshot_id  uuid NOT NULL REFERENCES ranking_snapshots,
  subject_id   uuid NOT NULL,                                    -- a user (player rankings) or a team (team rankings)
  rank         int NOT NULL,
  score        numeric NOT NULL,
  sample_n     int NOT NULL,
  events_n     int NOT NULL,
  evidence_ids uuid[] NOT NULL DEFAULT '{}',                     -- the verified results / fixtures that produced this row
  PRIMARY KEY (snapshot_id, subject_id)
);
CREATE INDEX IF NOT EXISTS ranking_snapshot_entries_subject ON ranking_snapshot_entries (subject_id, snapshot_id);
DROP TRIGGER IF EXISTS ranking_snapshot_immutable ON ranking_snapshots;
CREATE TRIGGER ranking_snapshot_immutable BEFORE UPDATE OR DELETE ON ranking_snapshots FOR EACH ROW EXECUTE FUNCTION ranking_record_immutable();
DROP TRIGGER IF EXISTS ranking_snapshot_entry_immutable ON ranking_snapshot_entries;
CREATE TRIGGER ranking_snapshot_entry_immutable BEFORE UPDATE OR DELETE ON ranking_snapshot_entries FOR EACH ROW EXECUTE FUNCTION ranking_record_immutable();

-- Integrity flags: "please look at this", never an accusation. Reviewed by a governor; dismissing keeps the row.
CREATE TABLE IF NOT EXISTS ranking_flags (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id uuid NOT NULL REFERENCES ranking_definitions,
  subject_id    uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('duplicate_evidence','rapid_activity','self_generated_fixtures')),
  detail        text NOT NULL,
  evidence_ids  uuid[] NOT NULL DEFAULT '{}',
  dedupe_key    text NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','confirmed','dismissed')),
  reviewed_by   uuid REFERENCES users,
  reviewed_at   timestamptz,
  review_note   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (definition_id, subject_id, kind, dedupe_key)
);
CREATE INDEX IF NOT EXISTS ranking_flags_open ON ranking_flags (definition_id, status);
