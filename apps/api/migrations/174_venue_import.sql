-- Venue bulk import (#697): extends the existing migration_projects / migration_rows tables for domain='venue'.
-- The existing roster domain is completely untouched. Venue rows store a different data_enc shape.
-- Additive only: no existing columns, rows or constraints are changed.

ALTER TABLE migration_projects ADD COLUMN IF NOT EXISTS
  venue_import_opts jsonb NOT NULL DEFAULT '{}';
  -- Shape: { currency: string, default_timezone: string, skip_existing: bool,
  --          overwrite_confirmed: uuid[], source_product: 'playo'|'gosports'|'teamsnap'|'sportsengine'|'excel'|'csv' }

-- Per-row conflict decision for venue imports (roster rows always leave this null).
ALTER TABLE migration_rows ADD COLUMN IF NOT EXISTS
  conflict_decision text CHECK (conflict_decision IN ('keep_existing','use_import','skip'));
ALTER TABLE migration_rows ADD COLUMN IF NOT EXISTS
  matched_venue_id uuid REFERENCES venues;

CREATE INDEX migration_rows_matched_venue
  ON migration_rows (matched_venue_id) WHERE matched_venue_id IS NOT NULL;

-- Composite index so the import worker can page through venue-domain projects efficiently.
CREATE INDEX migration_rows_project_domain
  ON migration_projects (domain, status, created_at DESC);
