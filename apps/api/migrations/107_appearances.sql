-- Verified appearances, substitutions and minutes (issue #322). Additive only: new tables and indexes, no existing data is changed.
-- Rollback: the tables are read only by the new capabilities and by the appearance-aware branches of athlete-history; dropping them
-- (a deliberate maintainer action, never automatic) returns history to the previous inference from squads.

CREATE TABLE IF NOT EXISTS match_appearances (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id       uuid NOT NULL REFERENCES fixtures,
  team_id          uuid NOT NULL REFERENCES teams,
  user_id          uuid NOT NULL REFERENCES users,
  status           text NOT NULL CHECK (status IN ('started','substitute_on','unused_sub','dnp')),
  on_clock_seconds  int CHECK (on_clock_seconds IS NULL OR on_clock_seconds >= 0),
  off_clock_seconds int CHECK (off_clock_seconds IS NULL OR off_clock_seconds >= 0),
  match_clock_seconds int CHECK (match_clock_seconds IS NULL OR match_clock_seconds >= 0),   -- length of play the minutes were measured against
  minutes_played   numeric(6,2) CHECK (minutes_played IS NULL OR minutes_played >= 0),         -- NULL = not verifiable (never 0 by default)
  minutes_basis    text CHECK (minutes_basis IN ('match_clock','scheduled_duration','staff_entry','official_sheet')),
  source           text NOT NULL CHECK (source IN ('lineup','substitution','staff','official_sheet','backfill')),
  authority        smallint NOT NULL DEFAULT 10,      -- 10 backfill/inferred, 20 team manager, 30 scorer/organiser, 40 official sheet
  row_version      int NOT NULL DEFAULT 1,
  client_key       text CHECK (client_key IS NULL OR length(client_key) BETWEEN 1 AND 64),
  created_by       uuid REFERENCES users,
  verified_by      uuid REFERENCES users,
  verified_at      timestamptz,
  archived_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fixture_id, user_id),
  CHECK (off_clock_seconds IS NULL OR on_clock_seconds IS NULL OR off_clock_seconds >= on_clock_seconds)
);
CREATE INDEX IF NOT EXISTS match_appearances_user ON match_appearances (user_id, fixture_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS match_appearances_fixture ON match_appearances (fixture_id, team_id, id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS match_appearance_revisions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appearance_id  uuid NOT NULL REFERENCES match_appearances,
  row_version    int NOT NULL,
  action         text NOT NULL CHECK (action IN ('lineup','substituted_off','substituted_on','substitution_voided','computed','corrected','verified','archived')),
  snapshot       jsonb NOT NULL,
  reason         text CHECK (reason IS NULL OR length(reason) <= 500),
  actor_id       uuid REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS match_appearance_revisions_app ON match_appearance_revisions (appearance_id, created_at, id);

CREATE TABLE IF NOT EXISTS match_substitutions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id    uuid NOT NULL REFERENCES fixtures,
  team_id       uuid NOT NULL REFERENCES teams,
  player_off_id uuid NOT NULL REFERENCES users,
  player_on_id  uuid NOT NULL REFERENCES users,
  period        int CHECK (period IS NULL OR period BETWEEN 1 AND 20),
  clock_seconds int NOT NULL CHECK (clock_seconds BETWEEN 0 AND 36000),
  client_key    text CHECK (client_key IS NULL OR length(client_key) BETWEEN 1 AND 64),
  recorded_by   uuid REFERENCES users,
  voided_at     timestamptz,
  voided_by     uuid REFERENCES users,
  void_reason   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (player_off_id <> player_on_id)
);
CREATE INDEX IF NOT EXISTS match_substitutions_fixture ON match_substitutions (fixture_id, clock_seconds, id);
CREATE UNIQUE INDEX IF NOT EXISTS match_substitutions_idem ON match_substitutions (fixture_id, client_key) WHERE client_key IS NOT NULL;
