-- Venue facility follow-ups (#585): guests are recorded on a check-in (so a membership's guest quota can be enforced), and a membership can
-- be the source of a hardware access grant. Additive only: one new column, one CHECK widened to allow one more value (no row changes).
ALTER TABLE access_captures ADD COLUMN IF NOT EXISTS guests int NOT NULL DEFAULT 0 CHECK (guests BETWEEN 0 AND 20);

DO $$
DECLARE n text;
BEGIN
  SELECT conname INTO n FROM pg_constraint WHERE conrelid = 'access_grants'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%source_type%';
  IF n IS NOT NULL THEN EXECUTE format('ALTER TABLE access_grants DROP CONSTRAINT %I', n); END IF;
  ALTER TABLE access_grants ADD CONSTRAINT access_grants_source_type_check CHECK (source_type IN ('booking','locker_assignment','accreditation','membership'));
END $$;
