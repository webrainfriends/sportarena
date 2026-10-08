-- Event discovery + lifecycle: location, capacity, registration deadline, currency and a waitlist state.
-- Additive only: new nullable/defaulted columns; the entry status CHECK is widened (no rows change).
ALTER TABLE events
  ADD COLUMN city text,
  ADD COLUMN capacity int CHECK (capacity IS NULL OR capacity > 0),
  ADD COLUMN registration_deadline timestamptz,
  ADD COLUMN currency text NOT NULL DEFAULT 'INR',
  ADD COLUMN seeking_sponsors boolean NOT NULL DEFAULT false;

ALTER TABLE event_entries
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN withdrawn_at timestamptz;
ALTER TABLE event_entries DROP CONSTRAINT event_entries_status_check;
ALTER TABLE event_entries ADD CONSTRAINT event_entries_status_check
  CHECK (status IN ('pending','accepted','rejected','withdrawn','waitlisted'));

CREATE INDEX events_search ON events (status, starts_on);
CREATE INDEX events_city ON events (lower(city));
