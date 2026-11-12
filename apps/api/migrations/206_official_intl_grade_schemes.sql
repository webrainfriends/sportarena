-- 206: International referee operations and tax localisation (R32, Issue #1030)
-- Additive only: no DROP / TRUNCATE / rewrites.
-- Three concerns:
--   (a) official_intl_prefs — per-official locale, timezone, payout country, invoice settings
--   (b) official_operating_countries — countries where an official operates + per-country consent
--   (c) official_grade_scheme_catalogue / _levels / _grades / _upgrade_applications
--       — country/association grade scheme catalog and official-level grade records
-- All PII fields are field-encrypted. Effective-dated where changes must be auditable.

-- ─────────────────────────────────────────────────────────────────────────────
-- (a) International locale preferences (one active row per official)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS official_intl_prefs (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid        NOT NULL REFERENCES users(id),
  -- Locale
  profile_language       text        NOT NULL DEFAULT 'en' CHECK (length(profile_language) BETWEEN 2 AND 10),
  comms_language         text        NOT NULL DEFAULT 'en' CHECK (length(comms_language) BETWEEN 2 AND 10),
  match_language         text        NOT NULL DEFAULT 'en' CHECK (length(match_language) BETWEEN 2 AND 10),
  timezone               text        NOT NULL DEFAULT 'UTC' CHECK (length(timezone) <= 64),
  date_locale            text        NOT NULL DEFAULT 'en-GB' CHECK (length(date_locale) <= 20),
  number_locale          text        NOT NULL DEFAULT 'en-AU' CHECK (length(number_locale) <= 20),
  currency_preference    char(3)     NOT NULL DEFAULT 'USD',
  -- Payout / invoice
  payout_country         char(2),                              -- ISO-3166-1 alpha-2; NULL = same as home country
  invoice_language       text        NOT NULL DEFAULT 'en' CHECK (length(invoice_language) BETWEEN 2 AND 10),
  tax_number_label       text        CHECK (length(tax_number_label) <= 60),   -- e.g. 'ABN' — auto-derived when NULL
  -- Timestamps
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);
CREATE INDEX IF NOT EXISTS official_intl_prefs_user ON official_intl_prefs(user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- (b) Countries where an official operates (many per official; soft-delete via removed_at)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS official_operating_countries (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid        NOT NULL REFERENCES users(id),
  country_code           char(2)     NOT NULL,                 -- ISO-3166-1 alpha-2
  is_home_country        bool        NOT NULL DEFAULT false,
  currency               char(3),                              -- typical currency for this country
  typical_tax_regime     text        CHECK (typical_tax_regime IN ('none','gst','vat','sales_tax','hst','consumption_tax','unknown')),
  typical_timezone       text        CHECK (length(typical_timezone) <= 64),
  -- Data residency consent fields (mirrors residency_consents structure)
  residency_consent_given  bool      NOT NULL DEFAULT false,
  residency_region         text      CHECK (length(residency_region) <= 64),   -- AWS region, e.g. eu-west-1
  consent_policy_version   int,
  consent_policy_hash      text      CHECK (length(consent_policy_hash) <= 64),
  consented_at             timestamptz,
  consent_revoked_at       timestamptz,
  -- Lifecycle
  added_at               timestamptz NOT NULL DEFAULT now(),
  removed_at             timestamptz,                          -- soft-delete; data kept permanently
  added_by               uuid        NOT NULL REFERENCES users(id),
  removed_by             uuid        REFERENCES users(id),
  UNIQUE (user_id, country_code)
);
CREATE INDEX IF NOT EXISTS ooc_user       ON official_operating_countries(user_id, removed_at NULLS FIRST);
CREATE INDEX IF NOT EXISTS ooc_country    ON official_operating_countries(country_code, removed_at NULLS FIRST);

-- ─────────────────────────────────────────────────────────────────────────────
-- (c-1) Grade scheme catalogue — one row per governing body × sport × effective version
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS official_grade_scheme_catalogue (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  sport_id               uuid        REFERENCES sports(id),    -- NULL = cross-sport scheme
  governing_body         text        NOT NULL CHECK (length(governing_body) BETWEEN 1 AND 120),
  governing_body_abbr    text        CHECK (length(governing_body_abbr) <= 20),
  country_scope          char(2),                              -- NULL = international / multi-country
  display_name           text        NOT NULL CHECK (length(display_name) BETWEEN 1 AND 160),
  description            text        CHECK (length(description) <= 2000),
  scheme_version         text        NOT NULL DEFAULT '1.0' CHECK (length(scheme_version) <= 20),
  effective_from         date        NOT NULL,
  effective_until        date,
  appeal_window_days     int         NOT NULL DEFAULT 30 CHECK (appeal_window_days BETWEEN 0 AND 365),
  tax_treatment          text        NOT NULL DEFAULT 'per_country'
                           CHECK (tax_treatment IN ('per_country','scheme_level','none','unknown')),
  status                 text        NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft','active','retired')),
  created_by             uuid        NOT NULL REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ogsc_sport    ON official_grade_scheme_catalogue(sport_id, status);
CREATE INDEX IF NOT EXISTS ogsc_country  ON official_grade_scheme_catalogue(country_scope, status);
CREATE INDEX IF NOT EXISTS ogsc_body     ON official_grade_scheme_catalogue(governing_body, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- (c-2) Individual grade levels within a scheme
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS official_grade_scheme_levels (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  scheme_id              uuid        NOT NULL REFERENCES official_grade_scheme_catalogue(id),
  level_code             text        NOT NULL CHECK (length(level_code) BETWEEN 1 AND 30),  -- e.g. '1','2','Gold','Elite'
  display_name           text        NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  description            text        CHECK (length(description) <= 1000),
  rank_order             int         NOT NULL DEFAULT 0,       -- lower = higher grade
  min_matches_required   int,
  min_assessment_score   int         CHECK (min_assessment_score BETWEEN 0 AND 100),
  requires_assessor_endorsement  bool  NOT NULL DEFAULT false,
  requires_fitness_cert  bool        NOT NULL DEFAULT false,
  requires_federation_approval   bool  NOT NULL DEFAULT false,
  archived_at            timestamptz,
  UNIQUE (scheme_id, level_code)
);
CREATE INDEX IF NOT EXISTS ogsgl_scheme ON official_grade_scheme_levels(scheme_id, rank_order);

-- ─────────────────────────────────────────────────────────────────────────────
-- (c-3) An official's current (and historical) grade in each scheme
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS official_scheme_grades (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid        NOT NULL REFERENCES users(id),
  scheme_id              uuid        NOT NULL REFERENCES official_grade_scheme_catalogue(id),
  level_id               uuid        NOT NULL REFERENCES official_grade_scheme_levels(id),
  status                 text        NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','superseded','revoked','expired')),
  verification_status    text        NOT NULL DEFAULT 'self_declared'
                           CHECK (verification_status IN ('self_declared','pending','verified','rejected','revoked')),
  assigned_by            uuid        REFERENCES users(id),     -- assessor / federation user; NULL = self-declared
  assigned_role          text        CHECK (assigned_role IN ('self','assessor','federation','admin')),
  assigned_reason        text        CHECK (length(assigned_reason) <= 500),
  effective_from         date        NOT NULL DEFAULT CURRENT_DATE,
  effective_until        date,
  verified_at            timestamptz,
  revoked_at             timestamptz,
  revoke_reason          text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS osg_user     ON official_scheme_grades(user_id, status, scheme_id);
CREATE INDEX IF NOT EXISTS osg_scheme   ON official_scheme_grades(scheme_id, status);
CREATE INDEX IF NOT EXISTS osg_level    ON official_scheme_grades(level_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- (c-4) Grade upgrade applications
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS official_grade_upgrade_applications (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid        NOT NULL REFERENCES users(id),
  scheme_id              uuid        NOT NULL REFERENCES official_grade_scheme_catalogue(id),
  current_level_id       uuid        NOT NULL REFERENCES official_grade_scheme_levels(id),
  target_level_id        uuid        NOT NULL REFERENCES official_grade_scheme_levels(id),
  status                 text        NOT NULL DEFAULT 'submitted'
                           CHECK (status IN ('submitted','assessor_requested','assessor_endorsed',
                                             'evidence_needed','in_review','approved','rejected','withdrawn')),
  -- Evidence checklist (JSON array of {key, label, met, evidence_note})
  evidence_checklist     jsonb       NOT NULL DEFAULT '[]',
  -- Assessor endorsement
  assessor_id            uuid        REFERENCES users(id),
  assessor_endorsed_at   timestamptz,
  assessor_notes         text        CHECK (length(assessor_notes) <= 1000),
  -- Federation decision
  decided_by             uuid        REFERENCES users(id),
  decided_at             timestamptz,
  decision_reason        text        CHECK (length(decision_reason) <= 1000),
  -- Appeal window
  appeal_deadline        date,
  appeal_submitted_at    timestamptz,
  appeal_outcome         text        CHECK (appeal_outcome IN ('upheld','dismissed')),
  -- Timestamps
  submitted_at           timestamptz NOT NULL DEFAULT now(),
  withdrawn_at           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ogua_user   ON official_grade_upgrade_applications(user_id, status);
CREATE INDEX IF NOT EXISTS ogua_scheme ON official_grade_upgrade_applications(scheme_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- (c-5) Grade scheme audit log (every assignment / status change)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS official_grade_audit_log (
  id                     bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id                uuid        NOT NULL REFERENCES users(id),
  scheme_id              uuid        NOT NULL REFERENCES official_grade_scheme_catalogue(id),
  grade_id               uuid        REFERENCES official_scheme_grades(id),
  application_id         uuid        REFERENCES official_grade_upgrade_applications(id),
  actor_id               uuid        NOT NULL REFERENCES users(id),
  actor_role             text,
  action                 text        NOT NULL,                 -- e.g. 'grade_assigned', 'grade_revoked', 'upgrade_approved'
  from_level_code        text,
  to_level_code          text,
  reason                 text,
  logged_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ogal_user   ON official_grade_audit_log(user_id, logged_at DESC);
CREATE INDEX IF NOT EXISTS ogal_scheme ON official_grade_audit_log(scheme_id, logged_at DESC);
