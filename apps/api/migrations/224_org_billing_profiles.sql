-- Effective-dated org billing profiles for India GST compliance

CREATE TABLE IF NOT EXISTS org_billing_profiles (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    UUID NOT NULL REFERENCES organisations(id),
  effective_from            DATE NOT NULL,
  archived_at               TIMESTAMPTZ,
  legal_name                TEXT NOT NULL,
  trade_name                TEXT,
  entity_type               VARCHAR(30),
  cin                       VARCHAR(21),
  gstin                     VARCHAR(15),
  pan_ref_enc               TEXT,
  tan_ref_enc               TEXT,
  state_code                CHAR(2),
  billing_address_enc       TEXT,
  invoice_prefix            VARCHAR(10),
  invoice_series            VARCHAR(20),
  current_number            INTEGER NOT NULL DEFAULT 1,
  auto_rotate_fy            BOOLEAN NOT NULL DEFAULT true,
  gst_registration_status   VARCHAR(20) NOT NULL DEFAULT 'regular',
  einvoice_threshold        BOOLEAN NOT NULL DEFAULT false,
  reverse_charge_applicable BOOLEAN NOT NULL DEFAULT false,
  lut_bond_number           TEXT,
  composition_rate_bp       INTEGER,
  default_sac_code          VARCHAR(10),
  tax_inclusive             BOOLEAN NOT NULL DEFAULT false,
  default_rate_bp           INTEGER NOT NULL DEFAULT 1800,
  rounding_policy           VARCHAR(20) NOT NULL DEFAULT 'half_up',
  withholding_matrix        JSONB,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by                UUID
);

CREATE INDEX IF NOT EXISTS idx_org_billing_profiles_org_effective
  ON org_billing_profiles (org_id, effective_from DESC);

COMMENT ON COLUMN org_billing_profiles.pan_ref_enc IS 'Encrypted PAN via src/crypto.js encrypt()';
COMMENT ON COLUMN org_billing_profiles.tan_ref_enc IS 'Encrypted TAN via src/crypto.js encrypt()';
COMMENT ON COLUMN org_billing_profiles.billing_address_enc IS 'Encrypted billing address';
COMMENT ON COLUMN org_billing_profiles.withholding_matrix IS '[{section_ref,label,rate_bp,threshold_cents,enabled}]';
COMMENT ON COLUMN org_billing_profiles.gst_registration_status IS 'regular|composition|sez|unregistered|overseas';
