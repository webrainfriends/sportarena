-- Elite wizard fields for seasons and cohorts. Additive only; data never deleted.
BEGIN;

ALTER TABLE org_seasons
  ADD COLUMN IF NOT EXISTS type                        text,
  ADD COLUMN IF NOT EXISTS reg_opens_on                date,
  ADD COLUMN IF NOT EXISTS reg_closes_on               date,
  ADD COLUMN IF NOT EXISTS sports                      text[],
  ADD COLUMN IF NOT EXISTS max_athletes                int,
  ADD COLUMN IF NOT EXISTS max_coaches                 int,
  ADD COLUMN IF NOT EXISTS age_bands                   text[],
  ADD COLUMN IF NOT EXISTS gender                      text,
  ADD COLUMN IF NOT EXISTS objective                   text,
  ADD COLUMN IF NOT EXISTS targets                     text,
  ADD COLUMN IF NOT EXISTS auto_roll_cohorts           boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS carry_forward_curriculum    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS self_registration           boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS notify_coaches_on_launch    boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS admin_notes                 text;

ALTER TABLE org_cohorts
  ADD COLUMN IF NOT EXISTS level                       text,
  ADD COLUMN IF NOT EXISTS age_group                   text,
  ADD COLUMN IF NOT EXISTS gender                      text,
  ADD COLUMN IF NOT EXISTS min_capacity                int,
  ADD COLUMN IF NOT EXISTS entry_requirements          text,
  ADD COLUMN IF NOT EXISTS schedule_days               text[],
  ADD COLUMN IF NOT EXISTS session_start_time          text,
  ADD COLUMN IF NOT EXISTS session_duration_minutes    int,
  ADD COLUMN IF NOT EXISTS session_type                text,
  ADD COLUMN IF NOT EXISTS waitlist                    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS guardian_consent_required   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS attendance_tracking         boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_eligible             boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS admin_notes                 text;

COMMIT;
