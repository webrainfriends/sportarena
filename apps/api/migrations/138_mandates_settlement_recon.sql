-- Recurring UPI mandates (Razorpay subscriptions) and provider settlement reconciliation (#694). Additive only; nothing is dropped or rewritten.

-- 1. A mandate is the payer's standing authorisation to charge a recurring coaching subscription or membership. Charges still go through
--    the canonical payments table and settle() (purpose coach_subscription_period / venue_plan); the mandate only records the authorisation.
CREATE TABLE IF NOT EXISTS payment_mandates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_id        uuid NOT NULL REFERENCES users(id),
  provider        text NOT NULL CHECK (provider IN ('razorpay')),
  provider_ref    text,                                  -- Razorpay subscription id
  subject_kind    text NOT NULL CHECK (subject_kind IN ('coach_subscription','membership')),
  subject_id      uuid NOT NULL,                         -- coach_subscriptions.id, or a user_plans.id of the membership being renewed
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0),
  currency        text NOT NULL,
  status          text NOT NULL DEFAULT 'created' CHECK (status IN ('created','authorised','active','halted','cancelled','completed')),
  authorised_at   timestamptz,
  last_charged_at timestamptz,
  cancelled_at    timestamptz,
  cancelled_by    uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_ref)
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_mandates_live ON payment_mandates (subject_kind, subject_id) WHERE status IN ('created','authorised','active');
CREATE INDEX IF NOT EXISTS payment_mandates_payer ON payment_mandates (payer_id, status);

-- 2. Provider settlements and what is inside them, matched against our payments.
CREATE TABLE IF NOT EXISTS provider_settlements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider       text NOT NULL,
  provider_ref   text NOT NULL,                          -- the provider's settlement id
  utr            text,
  currency       text NOT NULL,
  amount_minor   bigint NOT NULL DEFAULT 0,              -- net paid out to the bank
  fees_minor     bigint NOT NULL DEFAULT 0,
  tax_minor      bigint NOT NULL DEFAULT 0,
  settled_at     timestamptz,
  items_total    int NOT NULL DEFAULT 0,
  items_flagged  int NOT NULL DEFAULT 0,
  reconciled_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_ref)
);
CREATE TABLE IF NOT EXISTS provider_settlement_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id         uuid NOT NULL REFERENCES provider_settlements(id),
  entity_ref            text NOT NULL,                   -- payment / refund / adjustment id at the provider
  entity                text NOT NULL CHECK (entity IN ('payment','refund','adjustment','other')),
  provider_payment_ref  text,
  payment_id            uuid REFERENCES payments(id),
  amount_minor          bigint NOT NULL DEFAULT 0,
  fee_minor             bigint NOT NULL DEFAULT 0,
  tax_minor             bigint NOT NULL DEFAULT 0,
  occurred_at           timestamptz,
  match                 text NOT NULL CHECK (match IN ('matched','amount_mismatch','unknown_payment','refund_unrecorded','info')),
  UNIQUE (settlement_id, entity_ref, entity)
);
CREATE INDEX IF NOT EXISTS provider_settlement_items_payment ON provider_settlement_items (payment_id);

-- 3. New kinds of settlement exception (wider CHECK; existing rows are untouched).
ALTER TABLE settlement_exceptions DROP CONSTRAINT IF EXISTS settlement_exceptions_kind_check;
ALTER TABLE settlement_exceptions ADD CONSTRAINT settlement_exceptions_kind_check CHECK (kind IN (
  'paid_without_ledger','amount_mismatch','refund_unrecorded','provider_dispute','payout_failed','ledger_drift','share_mismatch',
  'mandate_charge_unmatched','settlement_unknown_payment','settlement_amount_mismatch','settlement_refund_unrecorded'));
