-- Elite coaching wizard: rich coaching profile data for academies (Nadal, Barcelona, Real Madrid tier).
-- Additive and idempotent — no existing data removed or altered.

-- ── 1. Enrich sport_profiles with coaching-specific fields ───────────────────
ALTER TABLE sport_profiles
  ADD COLUMN IF NOT EXISTS coaching_tier             varchar(30),
  ADD COLUMN IF NOT EXISTS athlete_levels            text[]    DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS coaching_specialisations  text[]    DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS session_formats           text[]    DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS coaching_bio_enc          text,
  ADD COLUMN IF NOT EXISTS peak_playing_level        varchar(30),
  ADD COLUMN IF NOT EXISTS booking_notice_hours      integer,
  ADD COLUMN IF NOT EXISTS group_rate_cents          integer,
  ADD COLUMN IF NOT EXISTS institutional_rate_cents  integer,
  ADD COLUMN IF NOT EXISTS weekly_hours              integer,
  ADD COLUMN IF NOT EXISTS travel_willing            boolean   DEFAULT false,
  ADD COLUMN IF NOT EXISTS coaching_languages        text[]    DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS dbs_status                varchar(20),
  ADD COLUMN IF NOT EXISTS dbs_issued_on             date,
  ADD COLUMN IF NOT EXISTS first_aid_expires_on      date,
  ADD COLUMN IF NOT EXISTS coaching_degree           varchar(200);

-- ── 2. Career history entries ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coach_career_entries (
  id               uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid         NOT NULL REFERENCES users(id),
  sport_profile_id uuid         REFERENCES sport_profiles(id),
  org_name         varchar(200) NOT NULL,
  role             varchar(100),
  city             varchar(100),
  country          varchar(80),
  started_year     integer,
  ended_year       integer,
  is_current       boolean      DEFAULT false,
  sort_order       integer      DEFAULT 0,
  created_at       timestamptz  DEFAULT now(),
  updated_at       timestamptz  DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coach_career_entries_user_id          ON coach_career_entries(user_id);
CREATE INDEX IF NOT EXISTS coach_career_entries_sport_profile_id ON coach_career_entries(sport_profile_id);

-- ── 3. Lightweight coaching licence declarations (not duplicate of verification_cases) ─
CREATE TABLE IF NOT EXISTS coach_sport_licences (
  id                   uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid         NOT NULL REFERENCES users(id),
  sport_profile_id     uuid         REFERENCES sport_profiles(id),
  issuing_body         varchar(200) NOT NULL,
  licence_level        varchar(100),
  licence_no_enc       text,
  country              varchar(80),
  expires_on           date,
  verification_case_id uuid         REFERENCES verification_cases(id),
  created_at           timestamptz  DEFAULT now(),
  updated_at           timestamptz  DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coach_sport_licences_user_id          ON coach_sport_licences(user_id);
CREATE INDEX IF NOT EXISTS coach_sport_licences_sport_profile_id ON coach_sport_licences(sport_profile_id);
