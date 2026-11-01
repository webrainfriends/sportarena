-- Saved discovery searches with optional alerts (#696). Additive only; archiving keeps the row.
CREATE TABLE saved_searches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users,
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  filters      jsonb NOT NULL DEFAULT '{}',          -- the discover_nearby inputs (never a precise home location: centre is rounded)
  alerts_on    boolean NOT NULL DEFAULT true,
  notified_keys text[] NOT NULL DEFAULT '{}',         -- items already announced, so an alert fires once per new match
  last_checked_at timestamptz,
  last_notified_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz
);
CREATE INDEX saved_searches_user ON saved_searches (user_id) WHERE archived_at IS NULL;
CREATE INDEX saved_searches_alerts ON saved_searches (alerts_on) WHERE archived_at IS NULL AND alerts_on;
