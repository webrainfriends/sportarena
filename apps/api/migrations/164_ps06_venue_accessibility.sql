-- PS-06: Verified accessible venue and facility discovery.
-- Additive only. Extends academy_venue_access_features (from #808) with rich
-- verification metadata and adds a venue_access_outages table. Nothing is dropped
-- or rewritten. Rollback: deploy the previous build (it ignores the new columns/table).

-- 1. Add verification metadata columns to the existing feature table.
ALTER TABLE academy_venue_access_features
  ADD COLUMN IF NOT EXISTS confidence     text NOT NULL DEFAULT 'self_reported'
                                          CHECK (confidence IN ('provisional','self_reported','third_party','certified')),
  ADD COLUMN IF NOT EXISTS source         text,
  ADD COLUMN IF NOT EXISTS assessor_name  text,
  ADD COLUMN IF NOT EXISTS evidence_ref   text,
  ADD COLUMN IF NOT EXISTS last_checked   date,
  ADD COLUMN IF NOT EXISTS expires_at     date,
  ADD COLUMN IF NOT EXISTS feature_detail jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS resource_id    uuid REFERENCES resources;

CREATE INDEX IF NOT EXISTS academy_vaf_resource
  ON academy_venue_access_features(resource_id) WHERE resource_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS academy_vaf_confidence
  ON academy_venue_access_features(venue_id, confidence) WHERE retired_at IS NULL;

-- 2. Outage / temporary unavailability. Append-only (resolved_at closes it).
CREATE TABLE IF NOT EXISTS venue_access_outages (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id    uuid        NOT NULL REFERENCES venues,
  feature     text        NOT NULL,
  resource_id uuid        REFERENCES resources,
  reason      text,
  starts_at   timestamptz NOT NULL DEFAULT now(),
  ends_at     timestamptz,
  raised_by   uuid        NOT NULL REFERENCES users,
  resolved_at timestamptz,
  resolved_by uuid        REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS venue_access_outages_active
  ON venue_access_outages(venue_id, feature) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS venue_access_outages_resource
  ON venue_access_outages(resource_id) WHERE resource_id IS NOT NULL AND resolved_at IS NULL;
