-- Rate cards record when they were last edited, activated or deactivated. The rate card capability has always written this column,
-- but migration 194 never added it, so every edit and every activation failed. Additive only; existing rows take their creation time.
ALTER TABLE official_profile_rates ADD COLUMN IF NOT EXISTS updated_at timestamptz;
UPDATE official_profile_rates SET updated_at = created_at WHERE updated_at IS NULL;
ALTER TABLE official_profile_rates ALTER COLUMN updated_at SET DEFAULT now();
