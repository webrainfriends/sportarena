-- Extend gov_cases with panel workflow columns (#479)
-- Additive only: assigns a case to a named staff member and schedules a hearing.
ALTER TABLE gov_cases
  ADD COLUMN IF NOT EXISTS assigned_to uuid REFERENCES users,
  ADD COLUMN IF NOT EXISTS hearing_at  timestamptz;
