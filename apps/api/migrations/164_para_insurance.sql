-- PS-24 Para-sport insurance: discipline attributes, exclusion disclosure, equipment asset linkage
-- Additive migration; no DROP, no TRUNCATE.

ALTER TABLE insurance_plans
  ADD COLUMN IF NOT EXISTS para_disciplines       text[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS para_event_types       text[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS para_equipment_cover   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS para_travel_cover      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS para_coverage_notes_enc text,
  ADD COLUMN IF NOT EXISTS para_exclusions        text,
  ADD COLUMN IF NOT EXISTS para_coverage_unknowns text;

CREATE INDEX IF NOT EXISTS ins_plans_para_disciplines ON insurance_plans USING GIN (para_disciplines);

ALTER TABLE insurance_policies
  ADD COLUMN IF NOT EXISTS para_equipment_assets jsonb NOT NULL DEFAULT '[]';

ALTER TABLE insurers
  ADD COLUMN IF NOT EXISTS para_capable     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS para_disciplines text[]  NOT NULL DEFAULT '{}';
