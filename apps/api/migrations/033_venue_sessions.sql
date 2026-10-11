-- Attach coaching / training sessions to venue bookings, and book coaching in recurring series.
-- Additive and idempotent: nothing is dropped or rewritten. A link that no longer applies is released (released_at), never deleted.

-- A recurring coaching booking creates one hire per date; the series row remembers the pattern they came from.
CREATE TABLE IF NOT EXISTS coach_series (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id   uuid NOT NULL REFERENCES users,
  hirer_id   uuid NOT NULL REFERENCES users,
  pattern    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE coach_hires ADD COLUMN IF NOT EXISTS series_id uuid REFERENCES coach_series;
CREATE INDEX IF NOT EXISTS coach_hires_series ON coach_hires (series_id) WHERE series_id IS NOT NULL;

-- Which venue booking line hosts a session. Many sessions may share one line (a group at one court).
CREATE TABLE IF NOT EXISTS session_venue_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES reservations,
  booking_id     uuid NOT NULL REFERENCES bookings,
  session_type   text NOT NULL CHECK (session_type IN ('coach_hire','training_session')),
  session_id     uuid NOT NULL,
  linked_by      uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  released_at    timestamptz,
  release_reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS session_venue_links_live ON session_venue_links (session_type, session_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS session_venue_links_booking ON session_venue_links (booking_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS session_venue_links_reservation ON session_venue_links (reservation_id);
