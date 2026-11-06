-- Elite venue compliance register enhancements: adds category, sub-type, issuing authority,
-- jurisdiction, verification status, coverage scope, responsible person, alert recipients,
-- configurable reminder cadence, renewal workflow, finance tracking, and conditions notes.
-- Additive only: existing rows and columns are untouched.

ALTER TABLE venue_compliance_items
  ADD COLUMN IF NOT EXISTS category             text,
  ADD COLUMN IF NOT EXISTS sub_type             text,
  ADD COLUMN IF NOT EXISTS issuing_authority    text,
  ADD COLUMN IF NOT EXISTS jurisdiction_country text,
  ADD COLUMN IF NOT EXISTS jurisdiction_region  text,
  ADD COLUMN IF NOT EXISTS verification_status  text
    CHECK (verification_status IN ('self_reported','third_party','certified')),
  ADD COLUMN IF NOT EXISTS coverage_scope       jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS responsible_user_id  uuid REFERENCES users ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS alert_recipient_ids  uuid[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS reminder_days        int[] DEFAULT '{90,60,30,14,7,1}',
  ADD COLUMN IF NOT EXISTS renewal_stage        text DEFAULT 'not_started'
    CHECK (renewal_stage IN ('not_started','applied','in_review','issued')),
  ADD COLUMN IF NOT EXISTS renewal_ref_enc      text,
  ADD COLUMN IF NOT EXISTS renewal_expected_on  date,
  ADD COLUMN IF NOT EXISTS annual_fee_cents     bigint,
  ADD COLUMN IF NOT EXISTS annual_fee_currency  text,
  ADD COLUMN IF NOT EXISTS renewal_estimate_cents bigint,
  ADD COLUMN IF NOT EXISTS last_paid_on         date,
  ADD COLUMN IF NOT EXISTS conditions_notes     text
    CHECK (conditions_notes IS NULL OR length(conditions_notes) <= 2000);

-- Index for the new analytics query (compliance score, cost totals) per venue
CREATE INDEX IF NOT EXISTS venue_compliance_items_category
  ON venue_compliance_items (venue_id, category, expires_on)
  WHERE archived_at IS NULL;

-- Index to look up items a user is responsible for (reminder dispatch)
CREATE INDEX IF NOT EXISTS venue_compliance_items_responsible
  ON venue_compliance_items (responsible_user_id)
  WHERE archived_at IS NULL AND responsible_user_id IS NOT NULL;
