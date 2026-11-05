-- PS-29: Partner-configurable local para-sport programmes and publicly verifiable grants.
-- Additive migration: no existing tables modified.
CREATE TABLE IF NOT EXISTS para_local_programmes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country_iso         CHAR(2) NOT NULL,
  sport_id            TEXT,
  name                TEXT NOT NULL,
  issuing_body        TEXT NOT NULL,
  eligibility_rules   TEXT,
  grant_min_minor     BIGINT,
  grant_max_minor     BIGINT,
  currency            CHAR(3),
  source_url          TEXT NOT NULL,
  source_ref          TEXT,
  verification_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified','sourced','verified')),
  verified_at         TIMESTAMPTZ,
  verified_by         UUID REFERENCES accounts(id),
  disclaimer          TEXT,
  active              BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_plp_country ON para_local_programmes(country_iso);
CREATE INDEX IF NOT EXISTS idx_plp_sport   ON para_local_programmes(sport_id);
CREATE INDEX IF NOT EXISTS idx_plp_status  ON para_local_programmes(verification_status);
