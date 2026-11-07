-- Elite application form: rich structured data on staff role applications.
-- Additive and idempotent — no existing data removed.

ALTER TABLE event_staff_assignments
  ADD COLUMN IF NOT EXISTS application_data jsonb;

ALTER TABLE event_staff_roles
  ADD COLUMN IF NOT EXISTS requirements             text,
  ADD COLUMN IF NOT EXISTS min_experience           text CHECK (min_experience IN ('any','some','experienced','expert')),
  ADD COLUMN IF NOT EXISTS qualifications_required  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS application_deadline     date;

CREATE INDEX IF NOT EXISTS event_staff_roles_deadline ON event_staff_roles (application_deadline) WHERE application_deadline IS NOT NULL;
