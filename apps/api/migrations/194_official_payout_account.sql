-- Official payout account onboarding (#1018). Additive only.
-- Rollback: DROP TABLE official_payout_audit, official_payout_failures;
--   ALTER TABLE payout_accounts DROP COLUMN IF EXISTS payee_type, legal_name_enc, tax_id_enc,
--     payout_schedule, kyc_provider, kyc_provider_ref, hold_reason, held_at, held_by,
--     released_at, released_by, source_role;

ALTER TABLE payout_accounts
  ADD COLUMN IF NOT EXISTS payee_type        text CHECK (payee_type IN ('individual','business')) DEFAULT 'individual',
  ADD COLUMN IF NOT EXISTS legal_name_enc    text,
  ADD COLUMN IF NOT EXISTS tax_id_enc        text,
  ADD COLUMN IF NOT EXISTS payout_schedule   text CHECK (payout_schedule IN ('weekly','fortnightly','monthly','on_demand')) DEFAULT 'monthly',
  ADD COLUMN IF NOT EXISTS kyc_provider      text,
  ADD COLUMN IF NOT EXISTS kyc_provider_ref  text,
  ADD COLUMN IF NOT EXISTS hold_reason       text,
  ADD COLUMN IF NOT EXISTS held_at           timestamptz,
  ADD COLUMN IF NOT EXISTS held_by           uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS released_at       timestamptz,
  ADD COLUMN IF NOT EXISTS released_by       uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS source_role       text DEFAULT 'seller';

-- Expand method constraint to include stripe_connect and digital_wallet
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'payout_accounts_method_check'
      AND table_name = 'payout_accounts'
  ) THEN
    ALTER TABLE payout_accounts DROP CONSTRAINT payout_accounts_method_check;
  END IF;
  ALTER TABLE payout_accounts ADD CONSTRAINT payout_accounts_method_check
    CHECK (method IN ('bank_transfer','stripe_connect','digital_wallet','paypal','other'));
END$$;

-- Payout failures surfaced to the official (failure records from payout items scoped to officials)
CREATE TABLE IF NOT EXISTS official_payout_failures (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES payout_accounts(id) ON DELETE RESTRICT,
  official_id     uuid NOT NULL REFERENCES users(id),
  payout_item_id  uuid REFERENCES payout_items(id),
  failure_code    text NOT NULL,
  failure_message text,
  amount_cents    bigint,
  currency        text,
  attempted_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  resolved_by     uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_opf_official  ON official_payout_failures(official_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_opf_account   ON official_payout_failures(account_id);

-- Audit log for sensitive-field reveals and admin actions on official payout accounts
CREATE TABLE IF NOT EXISTS official_payout_audit (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES payout_accounts(id),
  actor_id     uuid NOT NULL REFERENCES users(id),
  action       text NOT NULL,
  ip_address   inet,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_opa_account ON official_payout_audit(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_opa_actor   ON official_payout_audit(actor_id,   created_at DESC);
