-- Physio/doctor practice tax profile and rates (issue #210, slice 5). Additive, append-only: a later change never rewrites earlier versions.
-- No rate is hard-coded anywhere: the provider records the rate with its source (provenance) and effective date.
CREATE TABLE provider_tax_profiles (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id         uuid NOT NULL REFERENCES users,
  legal_name          text NOT NULL,
  jurisdiction        text NOT NULL,                          -- e.g. country / state as the provider states it
  registration_status text NOT NULL CHECK (registration_status IN ('registered','not_registered')),
  registration_id_enc text,                                   -- tax registration number, encrypted
  price_display       text NOT NULL DEFAULT 'inclusive' CHECK (price_display IN ('inclusive')),  -- tax-exclusive charging is a later slice
  effective_from      timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provider_tax_profiles_current ON provider_tax_profiles (provider_id, effective_from DESC);

CREATE TABLE provider_tax_rates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id    uuid NOT NULL REFERENCES users,
  tax_class      text NOT NULL CHECK (tax_class IN ('taxable')),   -- exempt / zero-rated / out-of-scope carry no tax by definition
  rate_bp        int NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),  -- basis points: 1800 = 18%
  source         text NOT NULL,                                    -- where the rate comes from (official notice / advisor); required
  effective_from timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provider_tax_rates_current ON provider_tax_rates (provider_id, tax_class, effective_from DESC);
