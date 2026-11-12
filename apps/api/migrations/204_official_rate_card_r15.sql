-- Migration 204: Official rate card R15 extensions (Issue #1007)
-- Adds age-band scoping, callout fee, extra-time rate, per diem, cancellation tiers and tax rate.
-- All additive; zero existing rows broken; backwards-compatible with R34 (migration 194).

ALTER TABLE official_profile_rates
  ADD COLUMN IF NOT EXISTS age_bands             text[]        DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS callout_fee_minor      bigint        DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extra_time_rate_minor  bigint        DEFAULT 0,
  ADD COLUMN IF NOT EXISTS per_diem_minor         bigint        DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cancellation_tiers     jsonb         DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS tax_rate_pct           numeric(5,2)  DEFAULT 0;

-- cancellation_tiers JSON schema (each element):
--   { "notice_hrs": integer, "fee_pct": numeric }
-- Ordered descending by notice_hrs; first matching tier (notice <= notice_hrs) fires.

COMMENT ON COLUMN official_profile_rates.age_bands IS
  'Age-band scope for this rate card, e.g. {u16,senior}. Empty = applies to all age groups.';
COMMENT ON COLUMN official_profile_rates.callout_fee_minor IS
  'Minimum fixed callout charge (minor currency units) payable regardless of match outcome.';
COMMENT ON COLUMN official_profile_rates.extra_time_rate_minor IS
  'Fee per extra-time period (AET, golden goal, penalty shootout) in minor currency units.';
COMMENT ON COLUMN official_profile_rates.per_diem_minor IS
  'Daily subsistence allowance for multi-day assignments (minor currency units per day).';
COMMENT ON COLUMN official_profile_rates.cancellation_tiers IS
  'Tiered cancellation schedule: [{notice_hrs,fee_pct},...] ordered descending by notice_hrs.';
COMMENT ON COLUMN official_profile_rates.tax_rate_pct IS
  'VAT / GST rate (%) applied when tax_inclusive=false to compute total_inc_tax in quotes.';

CREATE INDEX IF NOT EXISTS official_profile_rates_age_bands
  ON official_profile_rates USING gin(age_bands) WHERE archived_at IS NULL;
