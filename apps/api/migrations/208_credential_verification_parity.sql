-- 208: Coach / Referee / Physio credential verification parity
-- Additive only. No DROP TABLE, no TRUNCATE, no data-narrowing ALTER.

-- 1. Add 'referee' to the type CHECK constraint on verification_cases
DO $$
BEGIN
  ALTER TABLE verification_cases DROP CONSTRAINT IF EXISTS verification_cases_type_check;
  ALTER TABLE verification_cases ADD CONSTRAINT verification_cases_type_check
    CHECK (type IN ('gamer','coach','referee','physio','doctor','insurer','lawyer','recruiter','agent','sponsor','event'));
END $$;

-- 2. Referee-specific columns
ALTER TABLE verification_cases ADD COLUMN IF NOT EXISTS referee_grade_label      text;
ALTER TABLE verification_cases ADD COLUMN IF NOT EXISTS referee_competition_scope text;
ALTER TABLE verification_cases ADD COLUMN IF NOT EXISTS referee_official_role     text
  CHECK (referee_official_role IS NULL OR referee_official_role IN (
    'referee','umpire','assistant_referee','fourth_official','video_review',
    'scorer','line_judge','touch_judge','table_official'));

-- 3. Physio-specific columns
ALTER TABLE verification_cases ADD COLUMN IF NOT EXISTS physio_professional_body  text;
ALTER TABLE verification_cases ADD COLUMN IF NOT EXISTS physio_registration_no_enc text; -- AES-256-GCM, AAD='verification_cases.registration_no'
ALTER TABLE verification_cases ADD COLUMN IF NOT EXISTS physio_specialisations     text[] NOT NULL DEFAULT '{}';
ALTER TABLE verification_cases ADD COLUMN IF NOT EXISTS physio_indemnity_insurer   text;

-- 4. Renewal reminder tracking (idempotent via unique index)
CREATE TABLE IF NOT EXISTS verification_renewal_reminders (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid        NOT NULL REFERENCES verification_cases(id),
  window_days int         NOT NULL CHECK (window_days IN (90,60,30,7)),
  sent_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, window_days)
);

-- 5. Per-org / per-event credential verification policies
CREATE TABLE IF NOT EXISTS credential_verification_policies (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type      text        NOT NULL CHECK (owner_type IN ('org','event')),
  owner_id        uuid        NOT NULL,
  role            text        NOT NULL CHECK (role IN ('coach','referee','physio')),
  require_verified boolean    NOT NULL DEFAULT false,
  grace_days      int         NOT NULL DEFAULT 0 CHECK (grace_days >= 0 AND grace_days <= 90),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_type, owner_id, role)
);
CREATE INDEX IF NOT EXISTS idx_cred_policies_owner ON credential_verification_policies(owner_type, owner_id);
