-- Follow-ups to goods returns and service vouchers (#389). Additive only: no column is dropped or rewritten and no row is touched.

-- 1. A disputed return opens (or is linked to) a case in the existing sponsorship dispute system. One dispute per return.
ALTER TABLE sponsorship_disputes ADD COLUMN IF NOT EXISTS return_id uuid REFERENCES sponsorship_delivery_returns;
CREATE UNIQUE INDEX IF NOT EXISTS sponsorship_disputes_one_per_return ON sponsorship_disputes (return_id) WHERE return_id IS NOT NULL;
-- One live dispute per delivery stays true for whole-shipment disputes. Return disputes are scoped to their return instead (two returns from one delivery may each be disputed).
-- Only an index is rebuilt, narrower in what it forbids; no row is touched.
DROP INDEX IF EXISTS sponsorship_disputes_live_delivery;
CREATE UNIQUE INDEX IF NOT EXISTS sponsorship_disputes_live_delivery ON sponsorship_disputes (delivery_id) WHERE delivery_id IS NOT NULL AND return_id IS NULL AND status IN ('open','under_review','appealed');

-- 2. Evidence files for a return: same encrypted columns as case evidence, with provenance (who, when, consent).
CREATE TABLE IF NOT EXISTS sponsorship_return_files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id     uuid NOT NULL REFERENCES sponsorship_delivery_returns,
  label         text,
  file_name     text NOT NULL,
  content_type  text NOT NULL,
  size_bytes    integer NOT NULL,
  sha256        text NOT NULL,
  file_enc      text NOT NULL,
  added_by      uuid NOT NULL REFERENCES users,
  consent_at    timestamptz NOT NULL,                      -- the uploader agreed the other side and case reviewers may see this file
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sponsorship_return_files_return ON sponsorship_return_files (return_id, created_at, id);

-- 3. A coaching voucher may name the existing coaching session (hire) it paid for. One voucher per session.
ALTER TABLE sponsorship_voucher_redemptions ADD COLUMN IF NOT EXISTS hire_id uuid REFERENCES coach_hires;
CREATE UNIQUE INDEX IF NOT EXISTS sponsorship_redemptions_hire ON sponsorship_voucher_redemptions (hire_id) WHERE hire_id IS NOT NULL;
