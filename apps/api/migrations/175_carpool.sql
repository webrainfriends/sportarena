-- Parent carpool coordination (gaps audit, feature 2).
-- Additive only. No existing tables modified.

CREATE TABLE IF NOT EXISTS carpool_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id),
  driver_id uuid NOT NULL REFERENCES users(id),
  departure_location_enc text NOT NULL,
  area_label text NOT NULL,
  departure_time timestamptz NOT NULL,
  seats_available int NOT NULL CHECK (seats_available > 0 AND seats_available <= 8),
  return_offered boolean NOT NULL DEFAULT false,
  return_time timestamptz,
  recurring_rule text,
  vehicle_type text CHECK (vehicle_type IN ('car','minivan','van','other')),
  notes_enc text,
  driver_licence_verified boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','full','cancelled','completed')),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS carpool_offers_event ON carpool_offers(event_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS carpool_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id uuid NOT NULL REFERENCES carpool_offers(id),
  passenger_id uuid NOT NULL REFERENCES users(id),
  for_child_id uuid REFERENCES users(id),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','confirmed','declined','cancelled','completed')),
  pickup_location_enc text,
  pickup_area_label text,
  driver_rating int CHECK (driver_rating BETWEEN 1 AND 5),
  passenger_rating int CHECK (passenger_rating BETWEEN 1 AND 5),
  driver_rating_note_enc text,
  passenger_rating_note_enc text,
  late_cancel boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(offer_id, passenger_id)
);

CREATE INDEX IF NOT EXISTS carpool_bookings_offer ON carpool_bookings(offer_id);
CREATE INDEX IF NOT EXISTS carpool_bookings_passenger ON carpool_bookings(passenger_id);
