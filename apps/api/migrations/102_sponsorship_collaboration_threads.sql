-- Sponsor collaboration, part 2 (issue #306): brand-to-applicant program threads and automatic expiry tasks. Additive and backwards-compatible:
-- two columns, one index and relaxed/added CHECKs on the tables created in 100; no row is changed or removed.
--   sponsorship_tasks.system_key   marks a task the platform made itself ('expiry:<end date>'); unique per agreement, side and key.
--   sponsorship_notes.application_id  makes a note part of ONE application's thread: a conversation between the brand and that applicant.
-- A program note is the brand's internal note, OR part of one application's thread; an applicant's own message is always 'shared'.
-- Rollback: drop the new index/columns and restore the old program CHECK once no note has an application_id.
ALTER TABLE sponsorship_tasks ADD COLUMN IF NOT EXISTS system_key text;
CREATE UNIQUE INDEX IF NOT EXISTS sponsorship_tasks_system ON sponsorship_tasks (sponsorship_id, side, system_key) WHERE system_key IS NOT NULL;

ALTER TABLE sponsorship_notes ADD COLUMN IF NOT EXISTS application_id uuid REFERENCES sponsorship_applications;
DO $$
DECLARE c text;
BEGIN
  -- the original rule allowed program notes to be sponsor-internal only; threads need the applicant's shared messages too
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'sponsorship_notes'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%program_id IS NULL%' AND pg_get_constraintdef(oid) LIKE '%side%' AND pg_get_constraintdef(oid) NOT LIKE '%sponsorship_id%'
  LOOP EXECUTE format('ALTER TABLE sponsorship_notes DROP CONSTRAINT %I', c); END LOOP;
END $$;
ALTER TABLE sponsorship_notes ADD CONSTRAINT sponsorship_notes_program_scope CHECK (program_id IS NULL OR application_id IS NOT NULL OR (side = 'sponsor' AND visibility = 'internal'));
ALTER TABLE sponsorship_notes ADD CONSTRAINT sponsorship_notes_thread_scope CHECK (application_id IS NULL OR (program_id IS NOT NULL AND task_id IS NULL AND (side = 'sponsor' OR visibility = 'shared')));
CREATE INDEX IF NOT EXISTS sponsorship_notes_application ON sponsorship_notes (application_id, id) WHERE application_id IS NOT NULL;
