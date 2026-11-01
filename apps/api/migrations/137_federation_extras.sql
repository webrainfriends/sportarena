-- Federation extras (issue #703): licence ID card shares, background-check vendor adapter, census demographics.
-- Additive and backwards-compatible: nothing is dropped, rewritten or narrowed; no ON DELETE CASCADE; every statement is idempotent.

-- ------------------------------------------------------------------ 1. licence card: shareable links (the token is stored only as a hash)
CREATE TABLE IF NOT EXISTS fed_licence_card_shares (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  licence_id     uuid NOT NULL REFERENCES fed_licences,
  token_sha256   text NOT NULL UNIQUE,
  created_by     uuid NOT NULL REFERENCES users,
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  view_count     integer NOT NULL DEFAULT 0,
  last_viewed_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fed_licence_card_shares_licence ON fed_licence_card_shares (licence_id, created_at DESC);

-- ------------------------------------------------------------------ 2. background-check vendor adapter
-- Consent is evidence, append-only (a withdrawal is a stamp, never a delete). A check may only start while a current, unwithdrawn consent exists.
CREATE TABLE IF NOT EXISTS comp_check_consents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id        uuid NOT NULL REFERENCES users,
  requirement_id    uuid NOT NULL REFERENCES comp_requirements,
  statement_version integer NOT NULL DEFAULT 1,
  given_by          uuid NOT NULL REFERENCES users,          -- the person, or their verified guardian for a young person
  given_at          timestamptz NOT NULL DEFAULT now(),
  withdrawn_at      timestamptz
);
CREATE INDEX IF NOT EXISTS comp_check_consents_subject ON comp_check_consents (subject_id, requirement_id, given_at DESC);

-- The vendor side of one background-check record. Only the mapped state and the vendor's reference are kept: never the report itself.
CREATE TABLE IF NOT EXISTS comp_check_vendor (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id        uuid NOT NULL UNIQUE REFERENCES comp_records,
  provider         text NOT NULL CHECK (length(provider) <= 40),
  provider_ref_enc text NOT NULL,
  provider_ref_idx text NOT NULL,                            -- keyed blind index of the vendor reference, so a webhook finds its check without decrypting anything
  credential_id    uuid,                                     -- the credentials the check was ordered with (also used to poll it)
  state            text NOT NULL DEFAULT 'pending' CHECK (state IN ('clear','not_clear','pending')),
  consent_id       uuid NOT NULL REFERENCES comp_check_consents,
  started_by       uuid NOT NULL REFERENCES users,
  started_at       timestamptz NOT NULL DEFAULT now(),
  state_changed_at timestamptz,
  last_polled_at   timestamptz,
  last_error_code  text,
  confirmed_by     uuid REFERENCES users,                    -- the reviewer who confirmed (or rejected) the vendor result
  confirmed_at     timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS comp_check_vendor_ref ON comp_check_vendor (provider, provider_ref_idx);
CREATE INDEX IF NOT EXISTS comp_check_vendor_pending ON comp_check_vendor (last_polled_at NULLS FIRST) WHERE state = 'pending';

-- Vendor credentials, encrypted, one open row per organisation (NULL = platform) and provider; rotation closes the old row.
CREATE TABLE IF NOT EXISTS comp_vendor_credentials (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid REFERENCES organisations,
  provider        text NOT NULL CHECK (length(provider) <= 40),
  config_enc      text NOT NULL,
  effective_from  timestamptz NOT NULL DEFAULT now(),
  effective_to    timestamptz,
  created_by      uuid NOT NULL REFERENCES users
);
CREATE UNIQUE INDEX IF NOT EXISTS comp_vendor_credentials_open ON comp_vendor_credentials (organisation_id, provider) NULLS NOT DISTINCT WHERE effective_to IS NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'comp_check_vendor_credential_fk') THEN
    ALTER TABLE comp_check_vendor ADD CONSTRAINT comp_check_vendor_credential_fk FOREIGN KEY (credential_id) REFERENCES comp_vendor_credentials (id);
  END IF;
END $$;

-- Webhook replay protection.
CREATE TABLE IF NOT EXISTS comp_vendor_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    text NOT NULL,
  event_id    text NOT NULL,
  record_id   uuid REFERENCES comp_records,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);

-- ------------------------------------------------------------------ 3. census demographics
-- Year of birth only (coarse), derived whenever the DOB is saved and backfilled at start-up; the age band is computed live from it, and the DOB is never decrypted at query time.
ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_year smallint;

-- Gender is held only if the person chose to give it (opt-in), encrypted; gender_idx is a keyed blind index so a census can group without decrypting.
-- Withdrawing stamps withdrawn_at; the census then counts the person as "not stated".
CREATE TABLE IF NOT EXISTS person_demographics (
  user_id      uuid PRIMARY KEY REFERENCES users,
  gender_enc   text NOT NULL,
  gender_idx   text NOT NULL,
  basis        text NOT NULL DEFAULT 'consent' CHECK (basis IN ('consent')),
  given_by     uuid NOT NULL REFERENCES users,
  consent_at   timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
