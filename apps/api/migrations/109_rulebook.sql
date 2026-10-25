-- Rulebook and local rules (Tools > Sport rules). Additive only: nothing here changes or removes existing data.
-- The standard rulebook text lives in code (rulebook/catalog.js) and is never edited. A competition localises it by publishing a
-- local rule set: a named set of the few settings it changes, kept as immutable versions. Sheets pin the version they were made under.

CREATE TABLE IF NOT EXISTS local_rule_sets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport_id        uuid NOT NULL REFERENCES sports,
  format          text NOT NULL DEFAULT '',
  scope           text NOT NULL CHECK (scope IN ('personal','organisation','team','event')),
  owner_user_id   uuid NOT NULL REFERENCES users,
  organisation_id uuid REFERENCES organisations,
  team_id         uuid REFERENCES teams,
  event_id        uuid REFERENCES events,
  name            text NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  current_version int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'organisation') = (organisation_id IS NOT NULL)),
  CHECK ((scope = 'team') = (team_id IS NOT NULL)),
  CHECK ((scope = 'event') = (event_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS local_rule_sets_owner ON local_rule_sets(owner_user_id, status);
CREATE INDEX IF NOT EXISTS local_rule_sets_scope ON local_rule_sets(sport_id, scope, organisation_id, team_id, event_id);

CREATE TABLE IF NOT EXISTS local_rule_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id       uuid NOT NULL REFERENCES local_rule_sets,
  version      int NOT NULL,
  settings     jsonb NOT NULL DEFAULT '{}',
  base_hash    text NOT NULL,
  note         text,
  published_by uuid NOT NULL REFERENCES users,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (set_id, version)
);
CREATE OR REPLACE FUNCTION local_rule_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'published local rule versions are immutable'; END $$;
DROP TRIGGER IF EXISTS local_rule_version_immutable ON local_rule_versions;
CREATE TRIGGER local_rule_version_immutable BEFORE UPDATE OR DELETE ON local_rule_versions
  FOR EACH ROW EXECUTE FUNCTION local_rule_version_immutable();

-- What a scorer fills in around the game itself: team lists (numbers, names, captain, goalkeeper), toss, officials, period times.
-- Lives beside the sheet's entry history; it never carries a score.
ALTER TABLE tracking_sheets ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}';
-- The local rule version a sheet was started under (null = the standard rules).
ALTER TABLE tracking_sheets ADD COLUMN IF NOT EXISTS local_rule_version_id uuid REFERENCES local_rule_versions;
