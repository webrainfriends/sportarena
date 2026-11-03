-- Travel channel partners (#704): the platform admin connects one or more hotel / flight channel partners (an online travel site or a travel
-- gateway), each serving chosen kinds (stay, air) and chosen regions (ISO countries; none = worldwide). A trip searches every partner that serves
-- its destination at once and books through the one the person picks. Additive only: a new table and new nullable columns; nothing is dropped.
-- Credentials are encrypted (`config_enc`, `webhook_secret_enc`) and never returned. Partners are paused or archived, never deleted.
CREATE TABLE IF NOT EXISTS travel_channel_partners (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label        text NOT NULL CHECK (length(label) BETWEEN 2 AND 80),
  preset       text NOT NULL CHECK (preset IN ('booking_com','makemytrip','trip_com','agoda','expedia','other','sandbox')),
  provider_key text NOT NULL CHECK (provider_key IN ('travel_partner_https','travel_sandbox')),
  kinds        text[] NOT NULL CHECK (cardinality(kinds) > 0 AND kinds <@ ARRAY['stay','air']::text[]),
  regions      text[] NOT NULL DEFAULT '{}',                       -- ISO 3166-1 alpha-2; empty = worldwide
  mode         text NOT NULL DEFAULT 'live' CHECK (mode IN ('live','sandbox')),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  priority     int  NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 1000),   -- lower first when prices tie
  rate_per_minute int NOT NULL DEFAULT 60 CHECK (rate_per_minute BETWEEN 1 AND 6000),
  config_enc   text,
  webhook_secret_enc text,
  last_ok_at   timestamptz,
  last_error   text,
  created_by   uuid NOT NULL REFERENCES users,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz,
  CHECK (regions::text !~ '[^A-Z{},]')
);
CREATE INDEX IF NOT EXISTS travel_channel_partners_live ON travel_channel_partners (status, priority) WHERE archived_at IS NULL;

ALTER TABLE travel_bookings ADD COLUMN IF NOT EXISTS channel_partner_id uuid REFERENCES travel_channel_partners;
ALTER TABLE travel_bookings ADD COLUMN IF NOT EXISTS partner_label text;     -- the partner's name as it was when booked
CREATE UNIQUE INDEX IF NOT EXISTS travel_bookings_channel_ref ON travel_bookings (channel_partner_id, partner_ref) WHERE channel_partner_id IS NOT NULL AND partner_ref IS NOT NULL;
