-- Venue capacity and seating map (#480 follow-up). A venue records how many spectators it holds and lays out its stands as priced zones
-- (rows x seats, a price point such as premium / standard / economy, a colour and a default price). An event held there imports those zones
-- as its ticket sections (a copy, so later venue edits never change tickets already sold) and can create a draft ticket product for each.
-- Additive only: one nullable column, one new table, three nullable columns on ticket_sections. Nothing is removed or rewritten.

ALTER TABLE venues ADD COLUMN IF NOT EXISTS spectator_capacity integer CHECK (spectator_capacity IS NULL OR spectator_capacity >= 0);

CREATE TABLE venue_seat_zones (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id            uuid NOT NULL REFERENCES venues,
  name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  price_point         text NOT NULL DEFAULT 'standard' CHECK (price_point IN ('premium','vip','standard','economy','family','accessible','custom')),
  colour              text NOT NULL DEFAULT '#8B5CF6' CHECK (colour ~ '^#[0-9A-Fa-f]{6}$'),
  rows_count          integer NOT NULL CHECK (rows_count BETWEEN 1 AND 100),
  seats_per_row       integer NOT NULL CHECK (seats_per_row BETWEEN 1 AND 200),
  default_price_minor bigint NOT NULL DEFAULT 0 CHECK (default_price_minor >= 0),   -- in the venue's currency; an event may price it differently
  sort_order          integer NOT NULL DEFAULT 0,
  archived_at         timestamptz,
  created_by          uuid NOT NULL REFERENCES users,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX venue_seat_zones_name ON venue_seat_zones (venue_id, lower(name)) WHERE archived_at IS NULL;
CREATE INDEX venue_seat_zones_venue ON venue_seat_zones (venue_id) WHERE archived_at IS NULL;

ALTER TABLE ticket_sections
  ADD COLUMN IF NOT EXISTS venue_zone_id uuid REFERENCES venue_seat_zones,
  ADD COLUMN IF NOT EXISTS price_point   text CHECK (price_point IS NULL OR price_point IN ('premium','vip','standard','economy','family','accessible','custom')),
  ADD COLUMN IF NOT EXISTS colour        text CHECK (colour IS NULL OR colour ~ '^#[0-9A-Fa-f]{6}$');
CREATE INDEX IF NOT EXISTS ticket_sections_zone ON ticket_sections (venue_zone_id) WHERE venue_zone_id IS NOT NULL;
