-- Para rule packs (#834): declarative, versioned, publisher-attributed sport rules that a competition's eligibility policy points at.
-- Additive only. A published pack is immutable (edit = new version). Eligibility policies keep their own versions; the pack a policy used is
-- recorded in rules.para_pack_id and in every lineup snapshot, so a past decision is reproducible. Nothing here stores clinical information:
-- only class codes and administrative status come from the governed classification outcome (#488), read live.
CREATE TABLE IF NOT EXISTS para_rule_packs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events,
  sport_id    uuid NOT NULL REFERENCES sports,
  version     int  NOT NULL CHECK (version >= 1),
  title       text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  publisher   text NOT NULL CHECK (length(publisher) BETWEEN 2 AND 120),
  source_ref  text NOT NULL CHECK (length(source_ref) BETWEEN 2 AND 500),
  definition  jsonb NOT NULL,
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, version)
);
CREATE OR REPLACE FUNCTION para_rule_pack_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'a published para rule pack is never changed or deleted; publish a new version' USING ERRCODE = 'check_violation'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS para_rule_pack_immutable ON para_rule_packs;
CREATE TRIGGER para_rule_pack_immutable BEFORE UPDATE OR DELETE ON para_rule_packs FOR EACH ROW EXECUTE FUNCTION para_rule_pack_immutable();

-- The lineup decision locked for a fixture (lock / start): the pack version, the exact definition and the member classes used.
CREATE TABLE IF NOT EXISTS para_lineup_snapshots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events,
  fixture_id  uuid NOT NULL REFERENCES fixtures,
  team_id     uuid NOT NULL REFERENCES teams,
  stage       text NOT NULL CHECK (stage IN ('lock','start')),
  pack_id     uuid NOT NULL REFERENCES para_rule_packs,
  pack_version int NOT NULL,
  valid       boolean NOT NULL,
  members     jsonb NOT NULL,   -- user_id, class_code, status, slot, role, tags (no evidence, no clinical text)
  checks      jsonb NOT NULL,
  overrides   jsonb NOT NULL DEFAULT '[]',
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  locked_by   uuid REFERENCES users,
  UNIQUE (fixture_id, team_id, stage)
);

-- Competition-specific policy exceptions at lineup level need an approval step: requested by team staff, decided by a different organiser.
CREATE TABLE IF NOT EXISTS para_overrides (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events,
  pack_id     uuid NOT NULL REFERENCES para_rule_packs,
  fixture_id  uuid REFERENCES fixtures,        -- null = whole competition
  team_id     uuid NOT NULL REFERENCES teams,
  rule_id     text NOT NULL CHECK (length(rule_id) BETWEEN 1 AND 60),
  reason_enc  text NOT NULL,
  status      text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','rejected','revoked')),
  requested_by uuid NOT NULL REFERENCES users,
  decided_by  uuid REFERENCES users,
  decided_at  timestamptz,
  decision_note_enc text,
  effective_to timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
CREATE INDEX IF NOT EXISTS para_overrides_scope ON para_overrides (event_id, team_id, status);
