-- Godmode enhancements to official profile wizard (#991 R00): completeness scoring, compliance checklist,
-- multi-language bio, portfolio links. Additive only: no existing columns dropped or narrowed.

-- Profile-level additions
ALTER TABLE official_profiles
  ADD COLUMN IF NOT EXISTS completeness_score   smallint NOT NULL DEFAULT 0 CHECK (completeness_score BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS compliance_summary   jsonb,
  ADD COLUMN IF NOT EXISTS portfolio_links      jsonb,
  ADD COLUMN IF NOT EXISTS bio_translations     jsonb;

COMMENT ON COLUMN official_profiles.completeness_score   IS '0–100 computed after every wizard save; drives CompletenessBar in app.';
COMMENT ON COLUMN official_profiles.compliance_summary   IS 'Cached snapshot: array of {kind, status, expires_at, mandatory, label}. Recomputed on credential write.';
COMMENT ON COLUMN official_profiles.portfolio_links      IS 'Array of {kind, label, url} — video|article|match_report|other. Max 10.';
COMMENT ON COLUMN official_profiles.bio_translations     IS 'Map lang→encrypted_bio_text for the 11 platform language packs (en bio stays in bio_enc).';

-- Compliance extensions on credentials
ALTER TABLE official_profile_credentials
  ADD COLUMN IF NOT EXISTS compliance_kind     text CHECK (compliance_kind IS NULL OR compliance_kind IN
    ('dbs_police','safeguarding','fitness_test','insurance','anti_corruption','medical','other_compliance')),
  ADD COLUMN IF NOT EXISTS mandatory           boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS alert_days_before   smallint NOT NULL DEFAULT 30 CHECK (alert_days_before BETWEEN 1 AND 365);

COMMENT ON COLUMN official_profile_credentials.compliance_kind   IS 'Structured compliance category; NULL for ad-hoc credentials.';
COMMENT ON COLUMN official_profile_credentials.mandatory         IS 'If true, assignment engines block the official until this is active and unexpired.';
COMMENT ON COLUMN official_profile_credentials.alert_days_before IS 'Send expiry alert this many days before expiry_date.';

-- Index for compliance alert sweeps
CREATE INDEX IF NOT EXISTS official_profile_credentials_compliance
  ON official_profile_credentials(profile_id, compliance_kind, expiry_date)
  WHERE archived_at IS NULL AND compliance_kind IS NOT NULL;
