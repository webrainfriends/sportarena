-- Venue import (#697) fixes: the shared migration tables were created for the roster domain only, so their CHECK
-- constraints rejected every venue-domain row. This only WIDENS those constraints (every value that was allowed stays
-- allowed, no row is touched or removed); it is safe to run more than once.
--   migration_projects.domain          + 'venue'
--   migration_projects.source          + the venue import sources
--   migration_projects.status          + the venue import lifecycle: uploaded, checked, running, rolled_back (a rollback pauses venues; nothing is deleted)
--   migration_rows.commit_status       + 'committed', 'skipped'
--   migration_created.entity_kind      + 'venue' (the venues a project created, so a rollback only ever touches those)

ALTER TABLE migration_projects DROP CONSTRAINT IF EXISTS migration_projects_domain_check;
ALTER TABLE migration_projects ADD CONSTRAINT migration_projects_domain_check
  CHECK (domain IN ('roster', 'venue'));

ALTER TABLE migration_projects DROP CONSTRAINT IF EXISTS migration_projects_source_check;
ALTER TABLE migration_projects ADD CONSTRAINT migration_projects_source_check
  CHECK (source IN ('teamsnap', 'sportsengine', 'excel', 'csv',
                    'playo', 'gotsport', 'teamsnap_venue', 'sportsengine_venue'));

ALTER TABLE migration_projects DROP CONSTRAINT IF EXISTS migration_projects_status_check;
ALTER TABLE migration_projects ADD CONSTRAINT migration_projects_status_check
  CHECK (status IN ('draft', 'mapping', 'validation', 'dry_run', 'approved', 'importing', 'reconciliation',
                    'completed', 'rolled_back_partially', 'cancelled',
                    'uploaded', 'checked', 'running', 'rolled_back'));

ALTER TABLE migration_rows DROP CONSTRAINT IF EXISTS migration_rows_commit_status_check;
ALTER TABLE migration_rows ADD CONSTRAINT migration_rows_commit_status_check
  CHECK (commit_status IN ('invited', 'awaiting_signup', 'awaiting_consent', 'already_member', 'failed', 'rolled_back',
                           'committed', 'skipped'));

ALTER TABLE migration_created DROP CONSTRAINT IF EXISTS migration_created_entity_kind_check;
ALTER TABLE migration_created ADD CONSTRAINT migration_created_entity_kind_check
  CHECK (entity_kind IN ('team', 'venue'));
