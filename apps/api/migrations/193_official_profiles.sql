-- Referee / official profile onboarding wizard (#991 R00). Additive only: nothing is dropped or narrowed.
-- Reuses official_availability, official_prefs (migration 121), sport_profiles, fixture_officials (024).
-- New: self-declared profile per official with ten wizard-step sections, PII encryption throughout,
-- append-only history. Publishing the profile upserts sport_profiles and adds 'referee' to users.roles.

CREATE TABLE IF NOT EXISTS official_profiles (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES users(id),
  status                   text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','suspended','archived')),
  -- Step 0: identity
  display_name_pref        text CHECK (display_name_pref IS NULL OR length(display_name_pref) BETWEEN 1 AND 80),
  bio_enc                  text,
  preferred_pronouns       text CHECK (preferred_pronouns IS NULL OR length(preferred_pronouns) <= 40),
  nationality              text CHECK (nationality IS NULL OR length(nationality) <= 80),
  -- Step 1: privacy toggles
  privacy_show_sports      boolean NOT NULL DEFAULT true,
  privacy_show_experience  boolean NOT NULL DEFAULT true,
  privacy_show_credentials boolean NOT NULL DEFAULT true,
  privacy_show_rates       boolean NOT NULL DEFAULT true,
  -- Step 3: experience summary
  started_year             int CHECK (started_year IS NULL OR started_year BETWEEN 1950 AND EXTRACT(YEAR FROM now())::int),
  highest_level            text CHECK (highest_level IS NULL OR highest_level IN ('grassroots','local','district','county','regional','national','international','olympic')),
  total_matches_est        int CHECK (total_matches_est IS NULL OR total_matches_est BETWEEN 0 AND 99999),
  career_highlights_enc    text,
  -- Step 8: payout / tax
  tax_country              text CHECK (tax_country IS NULL OR length(tax_country) <= 80),
  vat_registered           boolean NOT NULL DEFAULT false,
  vat_number_enc           text,
  payout_method            text CHECK (payout_method IS NULL OR payout_method IN ('bank_transfer','stripe','other')),
  bank_account_enc         text,
  bank_sort_code_enc       text,
  bank_iban_enc            text,
  -- meta
  step_reached             int NOT NULL DEFAULT 0 CHECK (step_reached BETWEEN 0 AND 9),
  row_version              int NOT NULL DEFAULT 1,
  published_at             timestamptz,
  archived_at              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS official_profiles_user_live ON official_profiles(user_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS official_profiles_status ON official_profiles(status, updated_at DESC) WHERE archived_at IS NULL;

-- Sports × roles within a profile
CREATE TABLE IF NOT EXISTS official_profile_sports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id    uuid NOT NULL REFERENCES official_profiles(id),
  sport_id      uuid NOT NULL REFERENCES sports(id),
  role          text NOT NULL CHECK (role IN ('referee','umpire','linesman','scorer','judge','starter','timekeeper','video_referee')),
  discipline    text CHECK (discipline IS NULL OR length(discipline) <= 60),
  primary_sport boolean NOT NULL DEFAULT false,
  UNIQUE(profile_id, sport_id, role)
);
CREATE INDEX IF NOT EXISTS official_profile_sports_pid ON official_profile_sports(profile_id);

-- Per sport/role experience entries
CREATE TABLE IF NOT EXISTS official_profile_experience (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id       uuid NOT NULL REFERENCES official_profiles(id),
  sport_id         uuid NOT NULL REFERENCES sports(id),
  role             text NOT NULL CHECK (role IN ('referee','umpire','linesman','scorer','judge','starter','timekeeper','video_referee')),
  level            text NOT NULL DEFAULT 'local' CHECK (level IN ('grassroots','local','district','county','regional','national','international','olympic')),
  body_name        text NOT NULL CHECK (length(body_name) BETWEEN 1 AND 100),
  competition_name text CHECK (competition_name IS NULL OR length(competition_name) <= 100),
  from_year        int CHECK (from_year IS NULL OR from_year BETWEEN 1950 AND 2100),
  to_year          int CHECK (to_year IS NULL OR to_year BETWEEN 1950 AND 2100),
  match_count_est  int CHECK (match_count_est IS NULL OR match_count_est BETWEEN 0 AND 99999),
  notable_enc      text,
  display_order    int NOT NULL DEFAULT 0,
  archived_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS official_profile_experience_pid ON official_profile_experience(profile_id) WHERE archived_at IS NULL;

-- Credentials / certifications
CREATE TABLE IF NOT EXISTS official_profile_credentials (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id      uuid NOT NULL REFERENCES official_profiles(id),
  sport_id        uuid REFERENCES sports(id),
  role            text CHECK (role IS NULL OR role IN ('referee','umpire','linesman','scorer','judge','starter','timekeeper','video_referee')),
  kind            text NOT NULL DEFAULT 'licence' CHECK (kind IN ('licence','certification','course','badge','clearance','first_aid','fitness','safeguarding','other')),
  issuing_body    text NOT NULL CHECK (length(issuing_body) BETWEEN 1 AND 100),
  credential_name text NOT NULL CHECK (length(credential_name) BETWEEN 1 AND 100),
  issue_date      date,
  expiry_date     date,
  level_label     text CHECK (level_label IS NULL OR length(level_label) <= 60),
  reference_no_enc text,
  document_key    text,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','pending','suspended')),
  verified_at     timestamptz,
  verified_by     uuid REFERENCES users(id),
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS official_profile_credentials_pid ON official_profile_credentials(profile_id) WHERE archived_at IS NULL;

-- References (contact PII encrypted; never shown publicly)
CREATE TABLE IF NOT EXISTS official_profile_references (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id         uuid NOT NULL REFERENCES official_profiles(id),
  referee_name_enc   text NOT NULL,
  role_title         text CHECK (role_title IS NULL OR length(role_title) <= 80),
  organisation       text CHECK (organisation IS NULL OR length(organisation) <= 100),
  relationship       text NOT NULL DEFAULT 'other' CHECK (relationship IN ('governing_body','club','association','colleague','employer','other')),
  contact_email_enc  text,
  contact_phone_enc  text,
  consent_given      boolean NOT NULL DEFAULT false,
  contacted_at       timestamptz,
  display_order      int NOT NULL DEFAULT 0,
  archived_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS official_profile_references_pid ON official_profile_references(profile_id) WHERE archived_at IS NULL;

-- Rate cards
CREATE TABLE IF NOT EXISTS official_profile_rates (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id                    uuid NOT NULL REFERENCES official_profiles(id),
  sport_id                      uuid REFERENCES sports(id),
  role                          text CHECK (role IS NULL OR role IN ('referee','umpire','linesman','scorer','judge','starter','timekeeper','video_referee')),
  fixture_type                  text NOT NULL DEFAULT 'other' CHECK (fixture_type IN ('training','friendly','cup','league','tournament','international','other')),
  level_label                   text CHECK (level_label IS NULL OR length(level_label) <= 60),
  fee_minor                     bigint NOT NULL CHECK (fee_minor >= 0),
  fee_currency                  text NOT NULL CHECK (fee_currency ~ '^[A-Z]{3}$'),
  includes_travel               boolean NOT NULL DEFAULT false,
  travel_allowance_per_km_minor bigint CHECK (travel_allowance_per_km_minor IS NULL OR travel_allowance_per_km_minor >= 0),
  expenses_note                 text CHECK (expenses_note IS NULL OR length(expenses_note) <= 300),
  valid_from                    date,
  valid_until                   date,
  archived_at                   timestamptz,
  created_at                    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS official_profile_rates_pid ON official_profile_rates(profile_id) WHERE archived_at IS NULL;

-- Append-only status history
CREATE TABLE IF NOT EXISTS official_profile_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id  uuid NOT NULL REFERENCES official_profiles(id),
  from_status text,
  to_status   text NOT NULL,
  actor_id    uuid NOT NULL REFERENCES users(id),
  reason      text CHECK (reason IS NULL OR length(reason) <= 500),
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS official_profile_history_pid ON official_profile_history(profile_id, at DESC);

CREATE OR REPLACE FUNCTION official_profile_history_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'official_profile_history is append-only'; END $$;
DROP TRIGGER IF EXISTS official_profile_history_ro ON official_profile_history;
CREATE TRIGGER official_profile_history_ro BEFORE UPDATE OR DELETE ON official_profile_history FOR EACH ROW EXECUTE FUNCTION official_profile_history_append_only();
