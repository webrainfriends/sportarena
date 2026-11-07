-- PS-29: Country/jurisdiction-aware para-sport governance metadata.
-- Additive migration: no existing tables modified.
CREATE TABLE IF NOT EXISTS para_regional_governance (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sport_id        TEXT NOT NULL,
  country_iso     CHAR(2) NOT NULL,
  governing_body  TEXT NOT NULL,
  source_url      TEXT NOT NULL,
  source_ref      TEXT,
  effective_from  DATE,
  effective_to    DATE,
  event_divisions JSONB NOT NULL DEFAULT '[]',
  accreditation_refs JSONB NOT NULL DEFAULT '{}',
  federation_connection_type TEXT NOT NULL DEFAULT 'manual_offline'
    CHECK (federation_connection_type IN ('verified_api','manual_offline','pending_mou')),
  review_status   TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending','sourced','verified','flagged','rejected')),
  reviewed_at     TIMESTAMPTZ,
  reviewed_by     UUID REFERENCES users(id),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(sport_id, country_iso)
);
CREATE INDEX IF NOT EXISTS idx_prg_sport    ON para_regional_governance(sport_id);
CREATE INDEX IF NOT EXISTS idx_prg_country  ON para_regional_governance(country_iso);
CREATE INDEX IF NOT EXISTS idx_prg_status   ON para_regional_governance(review_status);
