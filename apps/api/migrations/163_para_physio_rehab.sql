-- Para-sport specialist physiotherapy and adapted rehabilitation (PS-16). Additive and backwards-compatible.
-- Extends canonical treatment-plans (#210), exercises, physio credentials and medical grants.
-- No diagnosis/condition/impairment field by design; specialisation is a service filter only.
-- Rollback: every statement uses IF NOT EXISTS / IF EXISTS; deploy the previous build to roll back.

-- ── 1. physio para-sport expertise ────────────────────────────────────────────────────────────────
-- Physio-owned declaration of adaptive service areas (never diagnoses athlete impairment from this).
CREATE TABLE IF NOT EXISTS physio_para_expertise (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id         uuid NOT NULL REFERENCES users(id),
  specialisation      text NOT NULL CHECK (specialisation IN (
    'wheelchair_load_management',
    'prosthetic_sport',
    'upper_limb_difference',
    'vision_impairment',
    'intellectual_matp',
    'acquired_disability',
    'hearing_impairment',
    'short_stature',
    'les_autres'
  )),
  credential_case_id  uuid,              -- optional link to a verification_cases row
  credential_note_enc text,              -- encrypted: credential body / registration number
  verified_at         timestamptz,       -- set when a matching verification_case is approved
  archived_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, specialisation)
);
CREATE INDEX IF NOT EXISTS physio_para_expertise_provider
  ON physio_para_expertise (provider_id)
  WHERE archived_at IS NULL;

-- ── 2. adapted exercise variants ──────────────────────────────────────────────────────────────────
-- Provider-authored variant of an exercise_version tailored for a specific adaptive context.
-- Multiple variants per exercise_version; each is linked to a treatment plan (or standalone library).
CREATE TABLE IF NOT EXISTS adapted_exercise_variants (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id              uuid NOT NULL REFERENCES users(id),
  exercise_version_id   uuid NOT NULL,     -- references exercise_versions(id), no FK to avoid cascade dep
  plan_id               uuid,              -- optional: treatment_plans(id), plan-scoped variant
  position_guidance_enc text,              -- encrypted: chair setup, stance, assistive-device note
  equipment_note_enc    text,              -- encrypted: adapted equipment, prosthetic considerations
  precautions_enc       text,              -- encrypted: stop criteria, safety flags
  media_url             text CHECK (media_url IS NULL OR media_url LIKE 'https://%'),
  media_source          text,
  media_licence         text,
  has_audio             boolean NOT NULL DEFAULT false,
  has_large_print       boolean NOT NULL DEFAULT false,
  archived_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS adapted_exercise_variants_owner
  ON adapted_exercise_variants (owner_id)
  WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS adapted_exercise_variants_plan
  ON adapted_exercise_variants (plan_id)
  WHERE plan_id IS NOT NULL AND archived_at IS NULL;

-- ── 3. treatment plan functional goals ────────────────────────────────────────────────────────────
-- Clinician-authored goals stored per treatment-plan (extends treatment_plans, never diagnosis).
CREATE TABLE IF NOT EXISTS treatment_plan_functional_goals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id         uuid NOT NULL REFERENCES treatment_plans(id),
  provider_id     uuid NOT NULL REFERENCES users(id),
  title_enc       text NOT NULL,                   -- encrypted
  measure_enc     text,                            -- encrypted: measure label, unit, target
  baseline_enc    text,                            -- encrypted: baseline value + date
  target_enc      text,                            -- encrypted: target value
  status          text NOT NULL DEFAULT 'in_progress' CHECK (status IN (
    'in_progress', 'achieved', 'not_met', 'discontinued'
  )),
  latest_pct      integer CHECK (latest_pct IS NULL OR (latest_pct >= 0 AND latest_pct <= 100)),
  latest_at       timestamptz,
  display_order   integer NOT NULL DEFAULT 0,
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tpfg_plan
  ON treatment_plan_functional_goals (plan_id)
  WHERE archived_at IS NULL;

-- ── 4. treatment plan outcome measures ────────────────────────────────────────────────────────────
-- Which clinician-selected outcome measures apply to this plan (no composite across impairments).
CREATE TABLE IF NOT EXISTS treatment_plan_outcome_measures (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id     uuid NOT NULL REFERENCES treatment_plans(id),
  provider_id uuid NOT NULL REFERENCES users(id),
  measure_key text NOT NULL,   -- e.g. 'wuspi', 'fim_mobility', 'dash', 'promis_pain', 'custom'
  label_enc   text,            -- encrypted: custom label when measure_key='custom'
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, measure_key)
);
CREATE INDEX IF NOT EXISTS tpom_plan
  ON treatment_plan_outcome_measures (plan_id)
  WHERE archived_at IS NULL;

-- ── 5. coaching readiness clearances ──────────────────────────────────────────────────────────────
-- Physio-issued clearance for coach notification. No clinical detail is ever copied to this table;
-- only the clearance status, load restriction and review date leave the clinical record.
CREATE TABLE IF NOT EXISTS coaching_readiness_clearances (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id          uuid NOT NULL REFERENCES treatment_plans(id),
  provider_id      uuid NOT NULL REFERENCES users(id),
  athlete_id       uuid NOT NULL REFERENCES users(id),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'superseded')),
  load_restriction text,                           -- plain text: e.g. 'Full training', 'Phase 2 load'
  review_date      date,
  -- athlete consent reference (medical_grants covers full clinical consent; this is narrower)
  consent_given_at timestamptz NOT NULL DEFAULT now(),
  consent_revoked_at timestamptz,
  -- coach(es) notified
  notified_coach_ids uuid[] NOT NULL DEFAULT '{}',
  issued_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz,
  revoked_by       uuid REFERENCES users(id),
  credential_id    uuid,                           -- credential row id at time of issue
  UNIQUE (plan_id, status) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS crc_plan
  ON coaching_readiness_clearances (plan_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS crc_athlete
  ON coaching_readiness_clearances (athlete_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS crc_provider
  ON coaching_readiness_clearances (provider_id);
