-- Saved favourite venues, and "tell me when a slot opens" alerts.
CREATE TABLE favourite_venues (
  user_id       uuid NOT NULL REFERENCES users,
  venue_id      uuid NOT NULL REFERENCES venues,
  notify_offers boolean NOT NULL DEFAULT true,     -- tell me when this venue adds an offer
  created_at    timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz,                       -- soft delete: un-favouriting keeps the row
  PRIMARY KEY (user_id, venue_id)
);
CREATE INDEX favourite_venues_venue ON favourite_venues (venue_id) WHERE removed_at IS NULL;

CREATE TABLE slot_alerts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users,
  venue_id    uuid NOT NULL REFERENCES venues,
  resource_id uuid REFERENCES resources,           -- null = any court (of the sport, if given)
  sport_id    uuid REFERENCES sports,
  date_from   date NOT NULL,                       -- venue-local dates
  date_to     date NOT NULL,
  weekdays    smallint[],                          -- null = every day
  from_min    int CHECK (from_min BETWEEN 0 AND 1439),   -- the slot must start at/after and end at/before this window
  to_min      int CHECK (to_min BETWEEN 1 AND 1440),
  slots       int NOT NULL DEFAULT 1 CHECK (slots BETWEEN 1 AND 12),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','fulfilled','cancelled','expired')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  found_starts_at timestamptz,
  found_resource_id uuid REFERENCES resources,
  CHECK (date_to >= date_from)
);
CREATE INDEX slot_alerts_active ON slot_alerts (venue_id) WHERE status = 'active';
CREATE INDEX slot_alerts_user ON slot_alerts (user_id, created_at DESC);
