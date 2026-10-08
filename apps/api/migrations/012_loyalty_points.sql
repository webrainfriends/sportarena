-- Venue loyalty: a venue gives a percentage of what a customer pays back as points, redeemable at that venue.
-- 1 point = 1 minor unit of the venue's currency (so points are always worth real money at the venue that issued them).
ALTER TABLE venues
  ADD COLUMN loyalty_earn_bp       int NOT NULL DEFAULT 0    CHECK (loyalty_earn_bp BETWEEN 0 AND 5000),      -- 0 = programme off; 500 = 5% back
  ADD COLUMN loyalty_expiry_months int NOT NULL DEFAULT 12   CHECK (loyalty_expiry_months BETWEEN 1 AND 60),
  ADD COLUMN loyalty_max_redeem_bp int NOT NULL DEFAULT 5000 CHECK (loyalty_max_redeem_bp BETWEEN 100 AND 10000);  -- share of one invoice that points may pay

-- Points come in lots so they can expire (oldest expiry is spent first).
CREATE TABLE loyalty_lots (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users,
  venue_id   uuid NOT NULL REFERENCES venues,
  invoice_id uuid REFERENCES invoices,               -- what earned them
  kind       text NOT NULL CHECK (kind IN ('earn','restore','bonus')),
  points     int NOT NULL CHECK (points > 0),
  remaining  int NOT NULL CHECK (remaining >= 0 AND remaining <= points),
  earned_at  timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX loyalty_lots_user ON loyalty_lots (user_id, venue_id, expires_at) WHERE remaining > 0;
CREATE UNIQUE INDEX loyalty_lots_one_earn_per_invoice ON loyalty_lots (invoice_id) WHERE kind = 'earn';

-- The statement: every change in someone's points at a venue.
CREATE TABLE loyalty_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users,
  venue_id   uuid NOT NULL REFERENCES venues,
  delta      int NOT NULL CHECK (delta <> 0),
  kind       text NOT NULL CHECK (kind IN ('earn','redeem','restore','clawback','expire','bonus')),
  invoice_id uuid REFERENCES invoices,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX loyalty_events_user ON loyalty_events (user_id, venue_id, created_at DESC);
CREATE INDEX loyalty_events_venue ON loyalty_events (venue_id, created_at DESC);

ALTER TABLE invoice_credits DROP CONSTRAINT invoice_credits_source_check;
ALTER TABLE invoice_credits ADD CONSTRAINT invoice_credits_source_check CHECK (source IN ('wallet','points'));   -- points: amount_cents = number of points
