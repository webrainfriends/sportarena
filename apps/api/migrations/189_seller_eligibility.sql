-- Additive only. Rollback: DROP TABLE seller_terms_log, coach_class_earning_splits,
-- provider_earnings_weekly; ALTER TABLE payout_accounts DROP COLUMN terms_accepted_at,
-- terms_version, settlement_config_ok, instant_eligible, instant_fee_bp;

ALTER TABLE payout_accounts
  ADD COLUMN IF NOT EXISTS terms_accepted_at    timestamptz,
  ADD COLUMN IF NOT EXISTS terms_version        text,
  ADD COLUMN IF NOT EXISTS settlement_config_ok boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS instant_eligible     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS instant_fee_bp       int;

CREATE TABLE IF NOT EXISTS seller_terms_log (
  id          bigserial PRIMARY KEY,
  owner_id    uuid NOT NULL REFERENCES users,
  currency    text NOT NULL,
  version     text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip_hash     text,
  user_agent  text
);
CREATE INDEX IF NOT EXISTS seller_terms_log_owner
  ON seller_terms_log (owner_id, accepted_at DESC);

CREATE TABLE IF NOT EXISTS coach_class_earning_splits (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id    uuid NOT NULL REFERENCES coach_classes ON DELETE RESTRICT,
  coach_id    uuid NOT NULL REFERENCES users,
  weight      int  NOT NULL CHECK (weight > 0),
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS coach_class_earning_splits_live
  ON coach_class_earning_splits (class_id, coach_id)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS provider_earnings_weekly (
  seller_id    uuid NOT NULL REFERENCES users,
  currency     text NOT NULL,
  week_start   date NOT NULL,
  gross_cents  bigint NOT NULL DEFAULT 0,
  net_cents    bigint NOT NULL DEFAULT 0,
  refund_cents bigint NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (seller_id, currency, week_start)
);
CREATE INDEX IF NOT EXISTS provider_earnings_weekly_seller
  ON provider_earnings_weekly (seller_id, currency, week_start DESC);
