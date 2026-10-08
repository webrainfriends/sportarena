-- Sold-out waitlist: join the queue for a specific court and time; when capacity frees up the first in line is offered
-- the slot, which is held for them for a few minutes (it counts as taken for everyone else).
CREATE TABLE waitlist_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users,
  venue_id    uuid NOT NULL REFERENCES venues,
  resource_id uuid NOT NULL REFERENCES resources,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  quantity    int NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  status      text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','offered','booked','expired','cancelled')),
  offered_at  timestamptz,
  offer_expires_at timestamptz,
  reservation_id uuid REFERENCES reservations,       -- set when the person books the freed slot
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX waitlist_queue ON waitlist_entries (resource_id, created_at) WHERE status = 'waiting';
CREATE INDEX waitlist_holds ON waitlist_entries (resource_id, starts_at, ends_at) WHERE status = 'offered';
CREATE INDEX waitlist_user ON waitlist_entries (user_id, created_at DESC);
