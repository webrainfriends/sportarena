ALTER TABLE sport_profiles
  ADD COLUMN IF NOT EXISTS hourly_rate_cents     int,
  ADD COLUMN IF NOT EXISTS base_city             text,
  ADD COLUMN IF NOT EXISTS rate_currency         char(3),
  ADD COLUMN IF NOT EXISTS online_rate_cents     int,
  ADD COLUMN IF NOT EXISTS trial_rate_cents      int,
  ADD COLUMN IF NOT EXISTS travel_radius_km      int,
  ADD COLUMN IF NOT EXISTS available_days        int[],
  ADD COLUMN IF NOT EXISTS min_commitment        text CHECK (min_commitment IN ('single','monthly','quarterly','seasonal','annual')),
  ADD COLUMN IF NOT EXISTS max_athletes          smallint,
  ADD COLUMN IF NOT EXISTS session_duration_min  smallint,
  ADD COLUMN IF NOT EXISTS base_lat              double precision,
  ADD COLUMN IF NOT EXISTS base_lng              double precision;
