-- Academy OS P2 (#805): capacity, progression and workforce scenarios. Strictly additive and backwards-compatible.
-- Capacity scenarios live in the SAME store as the #395 commercial scenarios (academy_scenarios), told apart by `kind`, so there is one
-- list, one snapshot model and one archive. No existing row is rewritten; existing rows become kind='commercial' by default.
ALTER TABLE academy_scenarios ADD COLUMN IF NOT EXISTS kind          text NOT NULL DEFAULT 'commercial';
ALTER TABLE academy_scenarios ADD COLUMN IF NOT EXISTS outcome       text;            -- capacity scenarios: complete | incomplete | impossible
ALTER TABLE academy_scenarios ADD COLUMN IF NOT EXISTS baseline_hash text;            -- sha256 of the sourced baseline, so a comparison can say whether two scenarios read the same data
ALTER TABLE academy_scenarios ADD COLUMN IF NOT EXISTS horizon_from  date;
ALTER TABLE academy_scenarios ADD COLUMN IF NOT EXISTS horizon_to    date;
ALTER TABLE academy_scenarios DROP CONSTRAINT IF EXISTS academy_scenarios_kind_check;
ALTER TABLE academy_scenarios ADD CONSTRAINT academy_scenarios_kind_check CHECK (kind IN ('commercial','capacity'));
ALTER TABLE academy_scenarios DROP CONSTRAINT IF EXISTS academy_scenarios_outcome_check;
ALTER TABLE academy_scenarios ADD CONSTRAINT academy_scenarios_outcome_check CHECK (outcome IS NULL OR outcome IN ('complete','incomplete','impossible'));
-- a capacity scenario can be priced in no currency when no cost is known: relaxing NOT NULL never narrows existing data
ALTER TABLE academy_scenarios ALTER COLUMN currency DROP NOT NULL;
CREATE INDEX IF NOT EXISTS academy_scenarios_kind ON academy_scenarios (organisation_id, kind, created_at DESC);

-- A person's decision on one recommendation candidate. Append-only: it records the decision and the reason, and changes NOTHING else.
-- Acting on an approved candidate is done by the owner in the screen that owns that record (sessions, staffing, programmes, pathways).
CREATE TABLE IF NOT EXISTS academy_scenario_decisions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  scenario_id     uuid NOT NULL REFERENCES academy_scenarios,
  candidate_key   text NOT NULL CHECK (length(candidate_key) BETWEEN 2 AND 80),
  decision        text NOT NULL CHECK (decision IN ('approved','declined','deferred')),
  reason          text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  decided_by      uuid NOT NULL REFERENCES users,
  idempotency_key text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_scenario_decisions_scenario ON academy_scenario_decisions (scenario_id, created_at DESC, id);
CREATE UNIQUE INDEX IF NOT EXISTS academy_scenario_decisions_idem ON academy_scenario_decisions (decided_by, idempotency_key) WHERE idempotency_key IS NOT NULL;
DROP TRIGGER IF EXISTS academy_scenario_decisions_immutable ON academy_scenario_decisions;
CREATE TRIGGER academy_scenario_decisions_immutable BEFORE UPDATE OR DELETE ON academy_scenario_decisions FOR EACH ROW EXECUTE FUNCTION academy_outcomes_append_only();

-- Rollback: nothing is dropped, because data is never deleted. Deploying the previous release is a safe rollback: it ignores the new columns and
-- the new table, and every pre-existing row keeps kind='commercial' and its currency. Capacity rows are hidden by archiving (archived_at), not removed.
