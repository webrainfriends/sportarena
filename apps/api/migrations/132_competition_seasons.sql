-- Competition → Season → Division → Round/Fixture → Standings (issue #476). Additive only: new tables, indexes and trigger functions; no existing row or column is touched.
-- A season IS a canonical `events` row (kind 'league'); teams enter it through `event_entries`, games are ordinary `fixtures` with their ordinary results. This layer only adds
-- what those tables never had: a persistent competition identity, versioned season rules, divisions, membership history, rounds, auditable adjustments and frozen standings.
-- No second match, team or score table. No ON DELETE CASCADE. Rule versions, membership history, adjustments, snapshots and movements are immutable by trigger, so a completed
-- season can always be reproduced. Rollback = stop using the capabilities; dropping the tables is a maintainer decision, never automatic.

CREATE TABLE IF NOT EXISTS comp_competitions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  slug            text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,78}$'),
  sport_id        uuid NOT NULL REFERENCES sports,
  organisation_id uuid REFERENCES organisations,                    -- the governing organisation / federation workspace
  owner_id        uuid NOT NULL REFERENCES users,
  country         text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  region          text CHECK (region IS NULL OR length(region) <= 80),
  level           text CHECK (level IS NULL OR level IN ('elite','professional','semi_pro','amateur','recreational','school','youth')),
  gender          text NOT NULL DEFAULT 'open' CHECK (gender IN ('open','men','women','mixed')),
  age_group       text CHECK (age_group IS NULL OR length(age_group) <= 40),
  description     text CHECK (description IS NULL OR length(description) <= 2000),
  is_public       boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','archived')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS comp_competitions_slug ON comp_competitions (lower(slug));
CREATE INDEX IF NOT EXISTS comp_competitions_org ON comp_competitions (organisation_id) WHERE organisation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS comp_seasons (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id  uuid NOT NULL REFERENCES comp_competitions,
  event_id        uuid NOT NULL UNIQUE REFERENCES events,           -- the canonical event that holds this season's entries, fixtures and results
  label           text NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  starts_on       date NOT NULL,
  ends_on         date NOT NULL,
  registration_opens_on  date,
  registration_closes_on date,
  transfer_opens_on      date,
  transfer_closes_on     date,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','active','completed','archived')),
  rule_policy_ref text CHECK (rule_policy_ref IS NULL OR length(rule_policy_ref) <= 120),     -- free reference to a rule pack / policy document (#68, #477)
  branding        jsonb NOT NULL DEFAULT '{}'::jsonb,
  champion_team_id uuid REFERENCES teams,
  previous_season_id uuid REFERENCES comp_seasons,
  completed_at    timestamptz,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on),
  CHECK (registration_closes_on IS NULL OR registration_opens_on IS NULL OR registration_closes_on >= registration_opens_on),
  CHECK (transfer_closes_on IS NULL OR transfer_opens_on IS NULL OR transfer_closes_on >= transfer_opens_on)
);
CREATE UNIQUE INDEX IF NOT EXISTS comp_seasons_label ON comp_seasons (competition_id, lower(label));
CREATE INDEX IF NOT EXISTS comp_seasons_comp ON comp_seasons (competition_id, starts_on DESC);

-- Versioned rules: every change is a new version; the version in force when a game was played is what the table is computed with.
CREATE TABLE IF NOT EXISTS comp_rule_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id   uuid NOT NULL REFERENCES comp_seasons,
  version     int  NOT NULL CHECK (version >= 1),
  rules       jsonb NOT NULL,
  note        text CHECK (note IS NULL OR length(note) <= 500),
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (season_id, version)
);

CREATE TABLE IF NOT EXISTS comp_divisions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id   uuid NOT NULL REFERENCES comp_seasons,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  kind        text NOT NULL DEFAULT 'division' CHECK (kind IN ('division','conference','pool','category')),
  tier        int  NOT NULL DEFAULT 1 CHECK (tier BETWEEN 1 AND 20),               -- 1 = top tier; promotion goes to tier-1, relegation to tier+1
  parent_id   uuid REFERENCES comp_divisions,                                        -- a conference/pool sits inside a division
  capacity    int  CHECK (capacity IS NULL OR capacity BETWEEN 2 AND 128),
  gender      text NOT NULL DEFAULT 'open' CHECK (gender IN ('open','men','women','mixed')),
  min_age     int  CHECK (min_age IS NULL OR min_age BETWEEN 4 AND 99),
  max_age     int  CHECK (max_age IS NULL OR max_age BETWEEN 4 AND 99),
  archived_at timestamptz,
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (min_age IS NULL OR max_age IS NULL OR min_age <= max_age)
);
CREATE UNIQUE INDEX IF NOT EXISTS comp_divisions_name ON comp_divisions (season_id, lower(name)) WHERE archived_at IS NULL;

-- A team in a season/division. The team stays canonical (teams); this row is only the membership and the eligibility it was accepted under.
CREATE TABLE IF NOT EXISTS comp_memberships (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id     uuid NOT NULL REFERENCES comp_seasons,
  division_id   uuid REFERENCES comp_divisions,
  team_id       uuid NOT NULL REFERENCES teams,
  status        text NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','invited','accepted','waitlisted','withdrawn','removed')),
  eligibility   jsonb,                                                               -- snapshot taken when the decision was made
  source_movement_id uuid,
  decided_by    uuid REFERENCES users,
  decided_at    timestamptz,
  created_by    uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- one live membership per team per season: the database, not the client, stops a team being in two divisions
CREATE UNIQUE INDEX IF NOT EXISTS comp_memberships_one_live ON comp_memberships (season_id, team_id) WHERE status IN ('applied','invited','accepted','waitlisted');
CREATE INDEX IF NOT EXISTS comp_memberships_division ON comp_memberships (division_id, status);
CREATE INDEX IF NOT EXISTS comp_memberships_team ON comp_memberships (team_id);

CREATE TABLE IF NOT EXISTS comp_membership_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id uuid NOT NULL REFERENCES comp_memberships,
  season_id     uuid NOT NULL REFERENCES comp_seasons,
  team_id       uuid NOT NULL REFERENCES teams,
  division_id   uuid REFERENCES comp_divisions,
  action        text NOT NULL CHECK (action IN ('applied','invited','accepted','waitlisted','withdrawn','removed','moved')),
  from_division_id uuid REFERENCES comp_divisions,
  reason        text CHECK (reason IS NULL OR length(reason) <= 500),
  actor_id      uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comp_membership_events_season ON comp_membership_events (season_id, created_at);

CREATE TABLE IF NOT EXISTS comp_rounds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id   uuid NOT NULL REFERENCES comp_seasons,
  division_id uuid NOT NULL REFERENCES comp_divisions,
  number      int  NOT NULL CHECK (number >= 1),
  label       text NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  starts_on   date,
  ends_on     date,
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (division_id, number),
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)
);

-- Links a canonical fixture to a division and round. The fixture, its teams and its result are never copied; outcome/postponement are separate, reasoned decisions.
CREATE TABLE IF NOT EXISTS comp_fixture_links (
  fixture_id  uuid PRIMARY KEY REFERENCES fixtures,
  season_id   uuid NOT NULL REFERENCES comp_seasons,
  division_id uuid NOT NULL REFERENCES comp_divisions,
  round_id    uuid REFERENCES comp_rounds,
  outcome     text NOT NULL DEFAULT 'played' CHECK (outcome IN ('played','forfeit_home','forfeit_away','double_forfeit')),   -- who forfeited (the forfeiting side loses)
  outcome_reason text CHECK (outcome_reason IS NULL OR length(outcome_reason) <= 500),
  outcome_by  uuid REFERENCES users,
  postponed_reason text CHECK (postponed_reason IS NULL OR length(postponed_reason) <= 500),
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comp_fixture_links_division ON comp_fixture_links (division_id, round_id);

-- Administrative adjustments (points deductions, awarded points) are explicit, reasoned and append-only; a mistake is corrected by a reversing row, never an edit.
CREATE TABLE IF NOT EXISTS comp_adjustments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id    uuid NOT NULL REFERENCES comp_seasons,
  division_id  uuid NOT NULL REFERENCES comp_divisions,
  team_id      uuid NOT NULL REFERENCES teams,
  points_delta int  NOT NULL CHECK (points_delta BETWEEN -100 AND 100 AND points_delta <> 0),
  reason       text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  reverses_id  uuid REFERENCES comp_adjustments,
  created_by   uuid NOT NULL REFERENCES users,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS comp_adjustments_reversed_once ON comp_adjustments (reverses_id) WHERE reverses_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS comp_adjustments_division ON comp_adjustments (division_id, team_id);

-- The final table of each division, frozen when the season completes together with the rule version and a hash, so it reads the same forever.
CREATE TABLE IF NOT EXISTS comp_standing_snapshots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id    uuid NOT NULL REFERENCES comp_seasons,
  division_id  uuid NOT NULL REFERENCES comp_divisions,
  rule_version int  NOT NULL,
  table_json   jsonb NOT NULL,
  members_json jsonb NOT NULL,
  hash         text NOT NULL,
  created_by   uuid NOT NULL REFERENCES users,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (division_id)
);

-- Season-end movements: proposed from the frozen tables, confirmed by a human, only then does a next-season membership (an invitation) exist.
CREATE TABLE IF NOT EXISTS comp_movements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id      uuid NOT NULL REFERENCES comp_seasons,
  team_id        uuid NOT NULL REFERENCES teams,
  from_division_id uuid NOT NULL REFERENCES comp_divisions,
  kind           text NOT NULL CHECK (kind IN ('promotion','relegation','qualification','playoff','champion','stay')),
  rank           int  NOT NULL,
  to_division_name text,
  to_tier        int,
  status         text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','confirmed','declined')),
  next_season_id uuid REFERENCES comp_seasons,
  next_membership_id uuid REFERENCES comp_memberships,
  decided_by     uuid REFERENCES users,
  decided_at     timestamptz,
  created_by     uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (season_id, team_id)
);

-- ---------------------------------------------------------------- immutability (history is never rewritten)
CREATE OR REPLACE FUNCTION comp_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% is append-only: record a new row instead of changing history', TG_TABLE_NAME USING ERRCODE = '23514'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS comp_rule_versions_immutable ON comp_rule_versions;
CREATE TRIGGER comp_rule_versions_immutable BEFORE UPDATE OR DELETE ON comp_rule_versions FOR EACH ROW EXECUTE FUNCTION comp_immutable();
DROP TRIGGER IF EXISTS comp_membership_events_immutable ON comp_membership_events;
CREATE TRIGGER comp_membership_events_immutable BEFORE UPDATE OR DELETE ON comp_membership_events FOR EACH ROW EXECUTE FUNCTION comp_immutable();
DROP TRIGGER IF EXISTS comp_adjustments_immutable ON comp_adjustments;
CREATE TRIGGER comp_adjustments_immutable BEFORE UPDATE OR DELETE ON comp_adjustments FOR EACH ROW EXECUTE FUNCTION comp_immutable();
DROP TRIGGER IF EXISTS comp_snapshots_immutable ON comp_standing_snapshots;
CREATE TRIGGER comp_snapshots_immutable BEFORE UPDATE OR DELETE ON comp_standing_snapshots FOR EACH ROW EXECUTE FUNCTION comp_immutable();

-- A completed or archived season is closed: its memberships, divisions, rounds and links no longer change (a later rule or team change cannot rewrite it).
CREATE OR REPLACE FUNCTION comp_season_closed() RETURNS trigger AS $$
DECLARE sid uuid; st text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME USING ERRCODE = '23514'; END IF;
  sid := NEW.season_id;
  SELECT status INTO st FROM comp_seasons WHERE id = sid;
  IF st IN ('completed','archived') THEN
    -- a closed season's memberships may only be touched in ways that leave status and division as they were
    IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'comp_memberships' THEN
      IF OLD.status IS DISTINCT FROM NEW.status OR OLD.division_id IS DISTINCT FROM NEW.division_id THEN RAISE EXCEPTION 'this season is % and its history is closed', st USING ERRCODE = '23514'; END IF;
    ELSE
      RAISE EXCEPTION 'this season is % and its history is closed', st USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS comp_memberships_closed ON comp_memberships;
CREATE TRIGGER comp_memberships_closed BEFORE INSERT OR UPDATE OR DELETE ON comp_memberships FOR EACH ROW EXECUTE FUNCTION comp_season_closed();
DROP TRIGGER IF EXISTS comp_divisions_closed ON comp_divisions;
CREATE TRIGGER comp_divisions_closed BEFORE INSERT OR UPDATE OR DELETE ON comp_divisions FOR EACH ROW EXECUTE FUNCTION comp_season_closed();
DROP TRIGGER IF EXISTS comp_rounds_closed ON comp_rounds;
CREATE TRIGGER comp_rounds_closed BEFORE INSERT OR UPDATE OR DELETE ON comp_rounds FOR EACH ROW EXECUTE FUNCTION comp_season_closed();
DROP TRIGGER IF EXISTS comp_links_closed ON comp_fixture_links;
CREATE TRIGGER comp_links_closed BEFORE INSERT OR UPDATE OR DELETE ON comp_fixture_links FOR EACH ROW EXECUTE FUNCTION comp_season_closed();
