-- Physio/doctor services & price catalogue (issue #210, slice 1). Additive only: nothing existing is changed or removed.
-- A service is a provider-owned, configurable product (assessment, follow-up, home visit…). Prices are append-only versions,
-- so changing tomorrow's price never touches an existing appointment. Services are archived, never deleted.
CREATE TABLE provider_services (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id   uuid NOT NULL REFERENCES users,
  title         text NOT NULL,
  description   text,                                         -- public: never clinical detail
  category      text NOT NULL DEFAULT 'consultation',
  delivery_modes text[] NOT NULL DEFAULT '{in_person}' CHECK (delivery_modes <@ ARRAY['in_person','remote']::text[] AND cardinality(delivery_modes) > 0),
  duration_min  int NOT NULL DEFAULT 30 CHECK (duration_min BETWEEN 10 AND 240),
  cancellation_policy text,
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provider_services_provider ON provider_services (provider_id) WHERE archived_at IS NULL;

CREATE TABLE provider_service_prices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id     uuid NOT NULL REFERENCES provider_services,
  price_cents    bigint NOT NULL CHECK (price_cents >= 0),
  currency       text NOT NULL,
  tax_class      text NOT NULL DEFAULT 'unspecified' CHECK (tax_class IN ('unspecified','taxable','exempt','zero_rated','out_of_scope')),
  effective_from timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provider_service_prices_current ON provider_service_prices (service_id, effective_from DESC);

-- what the patient agreed to, frozen at booking (all NULL for legacy appointments booked from the single consultation fee)
ALTER TABLE appointments
  ADD COLUMN service_id       uuid REFERENCES provider_services,
  ADD COLUMN service_price_id uuid REFERENCES provider_service_prices,
  ADD COLUMN service_title    text,
  ADD COLUMN tax_class        text,
  ADD COLUMN cancellation_policy text;
