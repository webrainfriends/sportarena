-- Migration 194: Extend official_profile_rates with service catalog fields (#1015 R34)
-- All new columns are nullable or have defaults so existing rows continue to work without change.

ALTER TABLE official_profile_rates
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS service_type text CHECK (service_type IN ('hourly','match','session','day')),
  ADD COLUMN IF NOT EXISTS weekend_sat_pct numeric(5,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS weekend_sun_pct numeric(5,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS holiday_pct numeric(5,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS overtime_rate_minor bigint DEFAULT 0,
  ADD COLUMN IF NOT EXISTS min_fee_minor bigint DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deposit_type text CHECK (deposit_type IN ('none','pct','fixed')) DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS deposit_pct numeric(5,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deposit_minor bigint DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_inclusive boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','archived')),
  ADD COLUMN IF NOT EXISTS version_number integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS deactivated_at timestamptz,
  ADD COLUMN IF NOT EXISTS private_notes_enc text,
  ADD COLUMN IF NOT EXISTS is_indicative boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS travel_radius_km integer DEFAULT 0;

-- Existing rows that pre-date this migration have no explicit status value yet; default is 'active' so they remain visible.
-- The archived_at column already exists and we keep it as the tombstone for the full-replace wizard path.

CREATE INDEX IF NOT EXISTS official_profile_rates_status ON official_profile_rates(profile_id, status) WHERE archived_at IS NULL;
