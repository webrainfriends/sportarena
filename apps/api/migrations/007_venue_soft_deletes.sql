-- Retire instead of delete: hours, contacts, staff and blocks are marked, never erased.
-- (005 shipped without these columns; adding them here keeps already-applied databases correct. Safe to re-run.)
ALTER TABLE venue_hours    ADD COLUMN IF NOT EXISTS removed_at  timestamptz;
ALTER TABLE venue_contacts ADD COLUMN IF NOT EXISTS removed_at  timestamptz;
ALTER TABLE venue_staff    ADD COLUMN IF NOT EXISTS removed_at  timestamptz;
ALTER TABLE venue_blocks   ADD COLUMN IF NOT EXISTS released_at timestamptz;
