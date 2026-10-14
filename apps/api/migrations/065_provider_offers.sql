-- Physio/doctor offers (issue #210, slice 2): time-limited percentage/fixed discounts on services. Additive only.
-- Separate from venue discounts on purpose: different owner (a provider, not a venue) and applied to appointments, not reservations.
CREATE TABLE provider_offers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id     uuid NOT NULL REFERENCES users,
  title           text NOT NULL,
  code            text,                                       -- NULL = applies automatically; otherwise the patient enters it
  kind            text NOT NULL CHECK (kind IN ('percent','fixed')),
  percent_bp      int CHECK (percent_bp BETWEEN 1 AND 10000), -- basis points: 1000 = 10%
  amount_cents    bigint CHECK (amount_cents > 0),
  currency        text,                                       -- required for fixed offers; only applies to prices in that currency
  service_ids     uuid[] NOT NULL DEFAULT '{}',               -- empty = every service of the provider
  valid_from      timestamptz,
  valid_to        timestamptz,
  max_redemptions int CHECK (max_redemptions > 0),
  per_user_limit  int CHECK (per_user_limit > 0),
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'percent' AND percent_bp IS NOT NULL) OR (kind = 'fixed' AND amount_cents IS NOT NULL AND currency IS NOT NULL)),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from)
);
CREATE UNIQUE INDEX provider_offers_code ON provider_offers (provider_id, upper(code)) WHERE code IS NOT NULL;

-- one redemption per appointment (unique), so retries cannot double count; it stops counting if the appointment is cancelled/expired
CREATE TABLE provider_offer_redemptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id       uuid NOT NULL REFERENCES provider_offers,
  appointment_id uuid NOT NULL UNIQUE REFERENCES appointments,
  user_id        uuid NOT NULL REFERENCES users,
  amount_cents   bigint NOT NULL CHECK (amount_cents >= 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provider_offer_redemptions_offer ON provider_offer_redemptions (offer_id);

ALTER TABLE appointments
  ADD COLUMN offer_id         uuid REFERENCES provider_offers,
  ADD COLUMN offer_title      text,
  ADD COLUMN list_price_cents bigint,
  ADD COLUMN discount_cents   bigint;
