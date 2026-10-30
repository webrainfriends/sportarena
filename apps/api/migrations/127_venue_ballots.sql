-- Venue slot balloting: a venue team opens a ballot for oversubscribed slots, people bid, winners are drawn (or allocated by hand)
-- and the slot is HELD for the winner until they pay. A held slot is not a booking: usedUnits / loadBusy count it as taken for
-- everyone else (like a waitlist offer), and it only becomes a real reservation, through the normal booking engine, when the
-- winner accepts. Additive only: no seed rows, no cascades.
CREATE TABLE venue_ballots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id           uuid NOT NULL REFERENCES venues,
  title              text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed','drawn','settled','cancelled')),
  method             text NOT NULL DEFAULT 'highest_bid' CHECK (method IN ('highest_bid','random_draw')),
  mode               text NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto','manual')),
  opens_at           timestamptz,
  closes_at          timestamptz NOT NULL,
  pay_window_minutes int NOT NULL DEFAULT 30 CHECK (pay_window_minutes BETWEEN 5 AND 2880),
  currency           text NOT NULL,
  draw_seed          text,
  drawn_at           timestamptz,
  created_by         uuid NOT NULL REFERENCES users,
  row_version        int NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX venue_ballots_venue ON venue_ballots (venue_id, status, closes_at);
CREATE INDEX venue_ballots_due ON venue_ballots (closes_at) WHERE status = 'open';

CREATE TABLE venue_ballot_slots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ballot_id       uuid NOT NULL REFERENCES venue_ballots,
  resource_id     uuid NOT NULL REFERENCES resources,
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  quantity        int NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  floor_cents     int NOT NULL DEFAULT 0 CHECK (floor_cents >= 0),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','offered','awaiting_payment','confirmed','unfilled','cancelled')),
  holder_user_id  uuid REFERENCES users,          -- the person the slot is held for while 'offered'
  winner_entry_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX venue_ballot_slots_ballot ON venue_ballot_slots (ballot_id);
-- the hold lookup used by the booking engine
CREATE INDEX venue_ballot_slots_holds ON venue_ballot_slots (resource_id, starts_at, ends_at) WHERE status IN ('open','offered');

CREATE TABLE venue_ballot_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ballot_id       uuid NOT NULL REFERENCES venue_ballots,
  slot_id         uuid NOT NULL REFERENCES venue_ballot_slots,
  user_id         uuid NOT NULL REFERENCES users,  -- who plays / pays
  entered_by      uuid NOT NULL REFERENCES users,  -- the guardian when a young person enters
  bid_cents       int NOT NULL CHECK (bid_cents >= 0),
  status          text NOT NULL DEFAULT 'entered' CHECK (status IN ('entered','ranked','offered','awaiting_payment','confirmed','lost','expired','withdrawn')),
  rank            int,
  hold_expires_at timestamptz,
  reservation_id  uuid REFERENCES reservations,
  idempotency_key text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- one live entry per person and slot; a replayed request with the same key is a no-op
CREATE UNIQUE INDEX venue_ballot_entries_live ON venue_ballot_entries (slot_id, user_id) WHERE status IN ('entered','ranked','offered','awaiting_payment','confirmed');
CREATE UNIQUE INDEX venue_ballot_entries_key ON venue_ballot_entries (user_id, slot_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX venue_ballot_entries_user ON venue_ballot_entries (user_id, created_at DESC);
CREATE INDEX venue_ballot_entries_due ON venue_ballot_entries (hold_expires_at) WHERE status = 'offered';
CREATE INDEX venue_ballot_entries_slot ON venue_ballot_entries (slot_id, status, rank);

-- append-only record of what the venue and the system did (draw seed, manual allocations, releases)
CREATE TABLE venue_ballot_log (
  id         bigserial PRIMARY KEY,
  ballot_id  uuid NOT NULL REFERENCES venue_ballots,
  actor_id   uuid REFERENCES users,
  action     text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX venue_ballot_log_ballot ON venue_ballot_log (ballot_id, id);
