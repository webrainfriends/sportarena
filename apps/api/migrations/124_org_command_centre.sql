-- Organisation Command Centre (#573). Additive only: nothing is dropped, rewritten or narrowed.
--  * a cohort name only has to be unique within a season (it was unique across the whole organisation), so a season
--    rollover can keep "Under 12" as "Under 12" in the new season. This relaxes a rule; every existing row still satisfies it.
--  * rolled_from_id links a rolled-over season / cohort back to its source, so a rollover can be traced and never repeated by accident.
--  * org_templates stores a reusable organisation structure (departments and groups) that its owners can apply to another organisation they run.
ALTER TABLE org_cohorts DROP CONSTRAINT IF EXISTS org_cohorts_organisation_id_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS org_cohorts_name_per_season ON org_cohorts (organisation_id, season_id, name) NULLS NOT DISTINCT;

ALTER TABLE org_seasons ADD COLUMN IF NOT EXISTS rolled_from_id uuid REFERENCES org_seasons;
ALTER TABLE org_cohorts ADD COLUMN IF NOT EXISTS rolled_from_id uuid REFERENCES org_cohorts;
CREATE UNIQUE INDEX IF NOT EXISTS org_cohorts_rolled_once ON org_cohorts (rolled_from_id, season_id) WHERE rolled_from_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS org_templates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id    uuid NOT NULL REFERENCES organisations,          -- the organisation it was saved from; its owners and admins can use it
  name               text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  kind               text NOT NULL,                                    -- the organisation type it was saved from
  structure          jsonb NOT NULL DEFAULT '{}',                      -- { departments: [name], cohorts: [{ name, capacity }] }; never people, money or personal data
  created_by         uuid NOT NULL REFERENCES users,
  created_at         timestamptz NOT NULL DEFAULT now(),
  archived_at        timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS org_templates_live_name ON org_templates (organisation_id, lower(name)) WHERE archived_at IS NULL;
