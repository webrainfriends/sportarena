-- Migration 223: extend athlete_measurements.metric to include 6 elite biometric keys.
-- Additive only: drops and replaces the check constraint (NOT VALID so existing rows are not scanned).
-- New keys: standing_long_jump, sit_and_reach, grip_strength, illinois_agility, beep_test_level, reaction_time
DO $$
BEGIN
  -- Remove any prior narrower constraint (migration 102 did not add one; this is a no-op on a fresh DB).
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'athlete_measurements'::regclass AND conname = 'athlete_measurements_metric_ck'
  ) THEN
    ALTER TABLE athlete_measurements DROP CONSTRAINT athlete_measurements_metric_ck;
  END IF;

  ALTER TABLE athlete_measurements ADD CONSTRAINT athlete_measurements_metric_ck
    CHECK (metric IN (
      'height', 'weight', 'wingspan', 'vertical_jump', 'sprint_20m', 'sprint_40m',
      'standing_long_jump', 'sit_and_reach', 'grip_strength', 'illinois_agility',
      'beep_test_level', 'reaction_time'
    )) NOT VALID;
END $$;
