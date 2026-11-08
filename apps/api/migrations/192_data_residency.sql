-- Add home_country to users (additive, nullable — existing accounts have no value yet)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS home_country char(2) CHECK (home_country IS NULL OR home_country ~ '^[A-Z]{2}$');

-- Control-plane directory: which AWS regions are provisioned and policy-approved per country
CREATE TABLE IF NOT EXISTS residency_region_catalog (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code     char(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  aws_region       varchar(30) NOT NULL,
  display_name     text NOT NULL,
  is_provisioned   boolean NOT NULL DEFAULT false,
  is_healthy       boolean NOT NULL DEFAULT false,
  is_policy_approved boolean NOT NULL DEFAULT false,
  policy_version   integer NOT NULL DEFAULT 1,
  effective_at     timestamptz NOT NULL DEFAULT now(),
  retired_at       timestamptz,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rrc_country ON residency_region_catalog(country_code);

-- Seed Phase A: Singapore is the only provisioned region
INSERT INTO residency_region_catalog
  (country_code, aws_region, display_name, is_provisioned, is_healthy, is_policy_approved, notes)
VALUES
  ('SG','ap-southeast-1','AWS Singapore',   true,  true,  true,  'Primary region — Phase A active'),
  ('IN','ap-south-1',    'AWS Mumbai',      false, false, false, 'India Phase B candidate (Mumbai)'),
  ('US','us-east-1',     'AWS US East',     false, false, false, 'US Phase B candidate'),
  ('CA','ca-central-1',  'AWS Canada',      false, false, false, 'Canada Phase B candidate'),
  ('AE','me-central-1',  'AWS UAE',         false, false, false, 'UAE Phase B candidate; restricted data types apply'),
  ('MY','ap-southeast-5','AWS Malaysia',    false, false, false, 'Opt-in region; must be enabled before declaring supported'),
  ('TH','ap-southeast-7','AWS Thailand',    false, false, false, 'Opt-in region; must be enabled before declaring supported'),
  ('LK','ap-southeast-1','AWS Singapore (fallback)', false, false, false, 'No native AWS region for Sri Lanka; Singapore fallback only with consent')
ON CONFLICT DO NOTHING;

-- Canonical region assignment per subject (user, org, minor, venue, event)
CREATE TABLE IF NOT EXISTS residency_assignments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind     text NOT NULL CHECK (subject_kind IN ('user','org','minor','venue','event')),
  subject_id       uuid NOT NULL,
  home_region      varchar(30) NOT NULL,
  jurisdiction     char(2) NOT NULL CHECK (jurisdiction ~ '^[A-Z]{2}$'),
  data_classification text NOT NULL DEFAULT 'personal',
  policy_version   integer NOT NULL DEFAULT 1,
  legal_basis      text NOT NULL,
  transfer_basis   text,
  lifecycle_status text NOT NULL DEFAULT 'active' CHECK (lifecycle_status IN ('active','migration_pending','migrating','archived')),
  assigned_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_kind, subject_id)
);
CREATE INDEX IF NOT EXISTS idx_ra_subject ON residency_assignments(subject_kind, subject_id);

-- Versioned consent records; never deleted
CREATE TABLE IF NOT EXISTS residency_consents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id       uuid NOT NULL REFERENCES users(id),
  guardian_id      uuid REFERENCES users(id),
  source_country   char(2) NOT NULL CHECK (source_country ~ '^[A-Z]{2}$'),
  destination_region varchar(30) NOT NULL,
  purposes         text[] NOT NULL,
  affirmative      boolean NOT NULL,
  policy_version   integer NOT NULL,
  policy_text_hash text NOT NULL,
  data_categories  text[] NOT NULL,
  decided_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz,
  revocation_reason text
);
CREATE INDEX IF NOT EXISTS idx_rc_subject ON residency_consents(subject_id);

-- Migration (transfer) workflow — 13-stage state machine
CREATE TABLE IF NOT EXISTS residency_transfers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id     uuid NOT NULL REFERENCES users(id),
  from_region    varchar(30) NOT NULL,
  to_region      varchar(30) NOT NULL,
  legal_basis    text NOT NULL,
  transfer_state text NOT NULL DEFAULT 'requested'
    CHECK (transfer_state IN ('requested','eligibility_review','owner_approval','inventory_frozen','destination_prepared','encrypted_copy','checksum_reconcile','dual_read','cutover_approval','destination_active','source_restricted','retention_erase','verified_complete','blocked','rolled_back','partial_hold')),
  manifest       jsonb,
  checksums      jsonb,
  requested_at   timestamptz NOT NULL DEFAULT now(),
  approved_at    timestamptz,
  completed_at   timestamptz,
  rollback_state jsonb
);
CREATE INDEX IF NOT EXISTS idx_rt_subject ON residency_transfers(subject_id);

-- Canonical storage location registry (populated by storage adapters, Phase B+)
CREATE TABLE IF NOT EXISTS storage_locations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_ref  text NOT NULL UNIQUE,
  record_kind    text NOT NULL,
  region         varchar(30) NOT NULL,
  store_type     text NOT NULL CHECK (store_type IN ('postgres','s3','local')),
  bucket_or_path text,
  owner_id       uuid,
  acl_context    text,
  retention_state text NOT NULL DEFAULT 'active' CHECK (retention_state IN ('active','frozen','erasing','erased')),
  checksum       text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
