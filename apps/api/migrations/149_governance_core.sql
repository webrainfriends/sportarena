-- Federation, Competition & Governance Core (#563): additive only. Nothing is dropped, rewritten or narrowed.
-- A rule pack bundles REFERENCES to the versions that govern a season (standings rules #476, eligibility policy #477, federation policy #475,
-- local playing rules #68) and freezes their resolved content + a hash at publish time, so a season replays exactly as it was played.

CREATE TABLE IF NOT EXISTS gov_rule_packs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id           uuid NOT NULL REFERENCES comp_competitions,
  version                  int  NOT NULL CHECK (version >= 1),
  name                     text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  standings_rule_version_id uuid REFERENCES comp_rule_versions,
  reg_policy_id            uuid REFERENCES reg_policies,
  fed_policy_version_ids   uuid[] NOT NULL DEFAULT '{}',
  local_rule_version_id    uuid REFERENCES local_rule_versions,
  content                  jsonb NOT NULL,              -- the resolved rules at publish time (what the season is judged by)
  hash                     text NOT NULL,
  note                     text CHECK (note IS NULL OR length(note) <= 500),
  backfilled               boolean NOT NULL DEFAULT false,
  published_by             uuid NOT NULL REFERENCES users,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (competition_id, version)
);

-- A season's pin history: the latest row is the pack in force; earlier rows stay as the record of what applied before.
CREATE TABLE IF NOT EXISTS gov_season_rule_pins (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id  uuid NOT NULL REFERENCES comp_seasons,
  pack_id    uuid NOT NULL REFERENCES gov_rule_packs,
  reason     text CHECK (reason IS NULL OR length(reason) <= 300),
  pinned_by  uuid NOT NULL REFERENCES users,
  pinned_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gov_season_rule_pins_season ON gov_season_rule_pins (season_id, pinned_at DESC);

-- The sealed record of a finished season: rule pack, memberships, final tables, eligibility snapshots, transfers and disciplinary decisions.
CREATE TABLE IF NOT EXISTS gov_season_archives (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id  uuid NOT NULL UNIQUE REFERENCES comp_seasons,
  bundle     jsonb NOT NULL,
  hash       text NOT NULL,
  sealed_by  uuid NOT NULL REFERENCES users,
  sealed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION gov_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% is append-only: publish a new row instead of changing history', TG_TABLE_NAME USING ERRCODE = '23514'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS gov_rule_packs_immutable ON gov_rule_packs;
CREATE TRIGGER gov_rule_packs_immutable BEFORE UPDATE OR DELETE ON gov_rule_packs FOR EACH ROW EXECUTE FUNCTION gov_immutable();
DROP TRIGGER IF EXISTS gov_season_rule_pins_immutable ON gov_season_rule_pins;
CREATE TRIGGER gov_season_rule_pins_immutable BEFORE UPDATE OR DELETE ON gov_season_rule_pins FOR EACH ROW EXECUTE FUNCTION gov_immutable();
DROP TRIGGER IF EXISTS gov_season_archives_immutable ON gov_season_archives;
CREATE TRIGGER gov_season_archives_immutable BEFORE UPDATE OR DELETE ON gov_season_archives FOR EACH ROW EXECUTE FUNCTION gov_immutable();

-- A completed or archived season keeps the pack it finished under.
CREATE OR REPLACE FUNCTION gov_pin_open_season() RETURNS trigger AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM comp_seasons WHERE id = NEW.season_id;
  IF st IN ('completed','archived') THEN RAISE EXCEPTION 'this season is % and its rule pack is closed', st USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS gov_season_rule_pins_open ON gov_season_rule_pins;
CREATE TRIGGER gov_season_rule_pins_open BEFORE INSERT ON gov_season_rule_pins FOR EACH ROW EXECUTE FUNCTION gov_pin_open_season();

-- Backfill: every existing season that already has standings rules or an eligibility policy gets a pack that records exactly what it has today.
-- (Existing data is kept as is; the pack only references it.) The pin trigger is bypassed for the one-off backfill of closed seasons.
ALTER TABLE gov_season_rule_pins DISABLE TRIGGER gov_season_rule_pins_open;
DO $$
DECLARE s RECORD; rv RECORD; rp RECORD; pid uuid; n int;
BEGIN
  FOR s IN SELECT cs.id, cs.competition_id, cs.event_id, cs.label, cs.created_by FROM comp_seasons cs
            WHERE NOT EXISTS (SELECT 1 FROM gov_season_rule_pins p WHERE p.season_id = cs.id) ORDER BY cs.created_at LOOP
    SELECT * INTO rv FROM comp_rule_versions WHERE season_id = s.id ORDER BY version DESC LIMIT 1;
    SELECT * INTO rp FROM reg_policies WHERE event_id = s.event_id ORDER BY version DESC LIMIT 1;
    IF rv.id IS NULL AND rp.id IS NULL THEN CONTINUE; END IF;
    SELECT coalesce(max(version), 0) + 1 INTO n FROM gov_rule_packs WHERE competition_id = s.competition_id;
    INSERT INTO gov_rule_packs (competition_id, version, name, standings_rule_version_id, reg_policy_id, content, hash, note, backfilled, published_by)
    VALUES (s.competition_id, n, left(s.label || ' (as it stood)', 120), rv.id, rp.id,
            jsonb_build_object('standings', rv.rules, 'standings_version', rv.version, 'eligibility', rp.rules, 'eligibility_version', rp.version, 'eligibility_enforcement', rp.enforcement),
            'md5:' || md5(coalesce(rv.rules::text, '') || '|' || coalesce(rp.rules::text, '')),
            'Recorded automatically from the rules this season already had.', true, s.created_by)
    RETURNING id INTO pid;
    INSERT INTO gov_season_rule_pins (season_id, pack_id, reason, pinned_by) VALUES (s.id, pid, 'Backfilled from existing season rules', s.created_by);
  END LOOP;
END $$;
ALTER TABLE gov_season_rule_pins ENABLE TRIGGER gov_season_rule_pins_open;
