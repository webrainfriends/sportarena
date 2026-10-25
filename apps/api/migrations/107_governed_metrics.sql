-- Governed sport metrics and scoring definitions (#320). Additive only: every definition version is immutable, results keep
-- the version they were scored with, and nothing existing is rewritten.

CREATE TABLE IF NOT EXISTS metric_definitions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport_id        uuid NOT NULL REFERENCES sports,
  key             text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9_]{0,39}$'),
  label           text NOT NULL,
  status          text NOT NULL DEFAULT 'published' CHECK (status IN ('published','retired')),
  current_version int NOT NULL DEFAULT 0,
  created_by      uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  retired_at      timestamptz,
  UNIQUE (sport_id, key)
);

CREATE TABLE IF NOT EXISTS metric_definition_versions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id         uuid NOT NULL REFERENCES metric_definitions,
  version               int NOT NULL CHECK (version >= 1),
  unit                  text NOT NULL CHECK (char_length(unit) BETWEEN 1 AND 12),
  direction             text NOT NULL CHECK (direction IN ('higher','lower')),
  aggregation           text NOT NULL CHECK (aggregation IN ('best','sum','mean','last')),
  value_kind            text NOT NULL CHECK (value_kind IN ('integer','decimal')),
  min_value             numeric NOT NULL,
  max_value             numeric NOT NULL,
  points_mode           text NOT NULL CHECK (points_mode IN ('flat','per_unit')),
  points_value          numeric NOT NULL CHECK (points_value >= 0),
  rankable_provenance   text[] NOT NULL DEFAULT '{approved_competition}',
  evidence_required_for text[] NOT NULL DEFAULT '{imported}',
  note                  text,
  hash                  text NOT NULL,
  client_key            text,
  created_by            uuid REFERENCES users,
  created_at            timestamptz NOT NULL DEFAULT now(),
  effective_from        timestamptz NOT NULL DEFAULT now(),
  CHECK (min_value < max_value),
  UNIQUE (definition_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS metric_versions_client_key ON metric_definition_versions (definition_id, client_key) WHERE client_key IS NOT NULL;

CREATE OR REPLACE FUNCTION governed_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'published rule versions are immutable'; END $$;
DROP TRIGGER IF EXISTS metric_version_immutable ON metric_definition_versions;
CREATE TRIGGER metric_version_immutable BEFORE UPDATE OR DELETE ON metric_definition_versions
  FOR EACH ROW EXECUTE FUNCTION governed_version_immutable();

-- Match formats / scoring rulesets, versioned. format_key 'default' is the sport's standard ruleset; others are named formats (best_of_5, t20 …).
CREATE TABLE IF NOT EXISTS ruleset_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport_id     uuid NOT NULL REFERENCES sports,
  format_key   text NOT NULL CHECK (format_key ~ '^[a-z0-9][a-z0-9_]{0,39}$'),
  version      int NOT NULL CHECK (version >= 1),
  label        text NOT NULL,
  ruleset      jsonb NOT NULL,
  ruleset_hash text NOT NULL,
  note         text,
  client_key   text,
  created_by   uuid REFERENCES users,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sport_id, format_key, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS ruleset_versions_client_key ON ruleset_versions (sport_id, format_key, client_key) WHERE client_key IS NOT NULL;
DROP TRIGGER IF EXISTS ruleset_version_immutable ON ruleset_versions;
CREATE TRIGGER ruleset_version_immutable BEFORE UPDATE OR DELETE ON ruleset_versions
  FOR EACH ROW EXECUTE FUNCTION governed_version_immutable();

-- Who besides platform admins may govern rules (soft revoke, never deleted). sport_id NULL = all sports.
CREATE TABLE IF NOT EXISTS metric_governors (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users,
  sport_id   uuid REFERENCES sports,
  granted_by uuid REFERENCES users,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS metric_governors_active ON metric_governors (user_id, coalesce(sport_id, '00000000-0000-0000-0000-000000000000')) WHERE revoked_at IS NULL;

-- Results and games remember the exact version they were scored under (NULL = scored before governance; see rule_version 0/1 legacy).
ALTER TABLE performances ADD COLUMN IF NOT EXISTS metric_version_id uuid REFERENCES metric_definition_versions;
ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS ruleset_version_id uuid REFERENCES ruleset_versions;
ALTER TABLE scoring_templates ADD COLUMN IF NOT EXISTS ruleset_version_id uuid REFERENCES ruleset_versions;
CREATE INDEX IF NOT EXISTS performances_metric_version ON performances (metric_version_id) WHERE metric_version_id IS NOT NULL;
