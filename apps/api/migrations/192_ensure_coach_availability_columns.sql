-- Defensive re-apply of migration 191 columns using IF NOT EXISTS.
-- If the ALTER TABLE in 191 never committed fully, these columns will be missing
-- and every Step 5 PATCH returns a 500. This migration is a no-op when all
-- columns already exist.
ALTER TABLE sport_profiles
  ADD COLUMN IF NOT EXISTS hourly_rate_cents     int,
  ADD COLUMN IF NOT EXISTS base_city             text,
  ADD COLUMN IF NOT EXISTS rate_currency         char(3),
  ADD COLUMN IF NOT EXISTS online_rate_cents     int,
  ADD COLUMN IF NOT EXISTS trial_rate_cents      int,
  ADD COLUMN IF NOT EXISTS travel_radius_km      int,
  ADD COLUMN IF NOT EXISTS available_days        int[],
  ADD COLUMN IF NOT EXISTS min_commitment        text,
  ADD COLUMN IF NOT EXISTS max_athletes          smallint,
  ADD COLUMN IF NOT EXISTS session_duration_min  smallint,
  ADD COLUMN IF NOT EXISTS base_lat              double precision,
  ADD COLUMN IF NOT EXISTS base_lng              double precision;
