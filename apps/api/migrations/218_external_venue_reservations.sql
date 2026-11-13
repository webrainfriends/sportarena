-- Migration 218: External venue reservation links and provider capability flags (additive only)
-- Separates external booking provenance from native bookings table (no false inventory ownership).

CREATE TABLE IF NOT EXISTS event_venue_reservation_links (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                      uuid NOT NULL REFERENCES events(id),
  event_session_id              uuid,
  provider_key                  text NOT NULL,
  integration_install_id        uuid,

  -- External venue identity (not GotMyGame-owned)
  external_venue_id             text,
  external_venue_name           text,
  external_venue_address        text,
  external_venue_city           text,
  external_venue_country        char(2),
  external_venue_lat            numeric(10,7),
  external_venue_lng            numeric(10,7),

  -- Encrypted references (personal/sensitive data)
  external_booking_reference_enc text,
  linkout_url_enc               text,

  -- Lifecycle status
  -- draft → quoted → hold_pending → redirect_pending → awaiting_confirmation → confirmed → fulfilled
  -- branches: failed / expired / cancelled / refunded / disputed
  status                        text NOT NULL DEFAULT 'draft'
                                  CHECK (status IN ('draft','quoted','hold_pending','redirect_pending',
                                    'awaiting_confirmation','confirmed','fulfilled',
                                    'failed','expired','cancelled','refunded','disputed')),

  -- Provenance of the confirmation
  source_status                 text NOT NULL DEFAULT 'unverified_linkout'
                                  CHECK (source_status IN ('provider_confirmed','organiser_attested','unverified_linkout')),

  -- How the venue was sourced
  venue_source                  text NOT NULL DEFAULT 'unassigned'
                                  CHECK (venue_source IN ('native','external_partner','external_manual','unassigned')),

  -- Time window
  starts_at                     timestamptz,
  ends_at                       timestamptz,
  timezone                      text,

  -- Sports & courts
  sport_keys                    text[] NOT NULL DEFAULT '{}',
  courts_requested              int,

  -- Pricing (minor currency units, e.g. cents)
  price_minor                   bigint,
  currency                      char(3),
  tax_minor                     bigint,
  fee_minor                     bigint,
  quote_expires_at              timestamptz,
  quote_fetched_at              timestamptz,

  -- Supporting documents and sync state
  receipt_document_id           uuid,
  provider_last_synced_at       timestamptz,

  -- Idempotency / replay protection for webhook ingestion
  dedup_key                     text UNIQUE,

  -- Soft lifecycle
  revoked_at                    timestamptz,
  replaced_by_id                uuid REFERENCES event_venue_reservation_links(id),

  created_by                    uuid NOT NULL REFERENCES users(id),
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS evrl_event_id_idx ON event_venue_reservation_links(event_id);
CREATE INDEX IF NOT EXISTS evrl_provider_key_idx ON event_venue_reservation_links(provider_key);
CREATE INDEX IF NOT EXISTS evrl_status_idx ON event_venue_reservation_links(status);
CREATE INDEX IF NOT EXISTS evrl_install_id_idx ON event_venue_reservation_links(integration_install_id) WHERE integration_install_id IS NOT NULL;

-- Platform-admin-governed capability flags per provider+country.
-- Only platform admins may insert/update rows here (enforced in app layer).
CREATE TABLE IF NOT EXISTS venue_booking_provider_caps (
  provider_key  text NOT NULL,
  country_code  char(2) NOT NULL DEFAULT '',   -- '' = global (all countries)
  cap_key       text NOT NULL,
  enabled       boolean NOT NULL DEFAULT false,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_key, country_code, cap_key)
);

-- Seed initial rows for known providers (additive — INSERT ... ON CONFLICT DO NOTHING).
INSERT INTO venue_booking_provider_caps (provider_key, country_code, cap_key, enabled) VALUES
  -- ActiveSG Singapore: redirect link-out only (no partner API yet)
  ('activesg_sg', 'SG', 'redirect.out',              true),
  ('activesg_sg', 'SG', 'venue.search',               false),
  ('activesg_sg', 'SG', 'venue.availability.read',    false),
  ('activesg_sg', 'SG', 'venue.price.quote',          false),
  ('activesg_sg', 'SG', 'venue.hold',                 false),
  ('activesg_sg', 'SG', 'venue.book',                 false),
  ('activesg_sg', 'SG', 'venue.cancel',               false),
  ('activesg_sg', 'SG', 'booking.status.read',        false),
  ('activesg_sg', 'SG', 'booking.webhook',            false),
  -- BookMyShow India: event listings/ticketing link-out only (not a venue rental platform)
  ('bookmyshow_in', 'IN', 'redirect.out',             true),
  ('bookmyshow_in', 'IN', 'venue.search',              false),
  ('bookmyshow_in', 'IN', 'venue.availability.read',   false),
  ('bookmyshow_in', 'IN', 'venue.price.quote',         false),
  ('bookmyshow_in', 'IN', 'venue.hold',                false),
  ('bookmyshow_in', 'IN', 'venue.book',                false),
  ('bookmyshow_in', 'IN', 'venue.cancel',              false),
  ('bookmyshow_in', 'IN', 'booking.status.read',       false),
  ('bookmyshow_in', 'IN', 'booking.webhook',           false),
  -- Sandbox: all capabilities enabled for development/testing
  ('venue_booking_sandbox', '', 'redirect.out',             true),
  ('venue_booking_sandbox', '', 'venue.search',             true),
  ('venue_booking_sandbox', '', 'venue.availability.read',  true),
  ('venue_booking_sandbox', '', 'venue.price.quote',        true),
  ('venue_booking_sandbox', '', 'venue.hold',               true),
  ('venue_booking_sandbox', '', 'venue.book',               true),
  ('venue_booking_sandbox', '', 'venue.cancel',             true),
  ('venue_booking_sandbox', '', 'booking.status.read',      true),
  ('venue_booking_sandbox', '', 'booking.webhook',          true)
ON CONFLICT DO NOTHING;
