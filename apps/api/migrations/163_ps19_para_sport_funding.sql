-- PS-19: Para-athlete specialist equipment and training sponsorship.
-- Purely additive: new columns with safe defaults, one new table. Nothing existing is altered in a breaking way.
-- Sponsor receives financial and operational delivery evidence only; clinical, classification medical and
-- disability inference data stay entirely outside this module's tables.

ALTER TABLE sponsorship_programs
  ADD COLUMN IF NOT EXISTS is_para_sport         BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS para_cost_categories  TEXT[]      NOT NULL DEFAULT '{}';

ALTER TABLE athlete_funding_needs
  ADD COLUMN IF NOT EXISTS para_need_types  TEXT[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS para_sport_code  TEXT;

-- Delivery evidence: operational confirmation only (supplier invoice, transport receipt, facility confirmation).
-- evidence_url is field-level encrypted (AES-256-GCM via src/crypto.js); no diagnosis or classification record is stored here.
CREATE TABLE IF NOT EXISTS para_sport_delivery_evidence (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sponsorship_id  UUID        NOT NULL REFERENCES sponsorships(id),
  athlete_id      UUID        NOT NULL REFERENCES users(id),
  need_type       TEXT        NOT NULL,
  evidence_type   TEXT        NOT NULL CHECK (evidence_type IN ('supplier_invoice','delivery_confirmation','transport_receipt','facility_confirmation','other')),
  amount_pence    INTEGER     NOT NULL CHECK (amount_pence >= 0),
  supplier_name   TEXT,
  evidence_url_enc TEXT,
  confirmed_at    TIMESTAMPTZ,
  submitted_by    UUID        NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_psde_sponsorship ON para_sport_delivery_evidence(sponsorship_id);
CREATE INDEX IF NOT EXISTS idx_psde_athlete     ON para_sport_delivery_evidence(athlete_id);

-- Audit log for every sponsor read of delivery evidence (privacy requirement).
CREATE TABLE IF NOT EXISTS para_sport_evidence_audit (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id     UUID        NOT NULL REFERENCES para_sport_delivery_evidence(id),
  accessed_by     UUID        NOT NULL REFERENCES users(id),
  sponsor_id      UUID        NOT NULL REFERENCES sponsors(id),
  accessed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_psea_evidence ON para_sport_evidence_audit(evidence_id);
CREATE INDEX IF NOT EXISTS idx_psea_sponsor  ON para_sport_evidence_audit(sponsor_id);
