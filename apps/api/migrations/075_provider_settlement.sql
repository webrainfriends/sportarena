-- Provider earnings, settlement and payment reconciliation (issue #71, PROD-08).
-- Additive only: no existing table, column or row is changed. `payments.status = 'paid'` keeps meaning "the customer paid the platform";
-- what the platform then owes a coach / physio / doctor / shop seller lives here, in an append-only ledger linked to the payment.
-- Venue operators keep settling through partner contracts (028_partners.sql); wallet top-ups and gift cards are platform value, not provider funds.
-- Rollback: these tables are new and nothing else references them, so dropping them (in reverse order) restores the previous schema.
-- Existing paid payments are back-filled into the ledger by the idempotent `reconcile_settlement` capability, not by this migration.

-- ---------------------------------------------------------------- where a seller is paid
CREATE TABLE payout_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id       uuid NOT NULL REFERENCES users,
  currency       text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  method         text NOT NULL DEFAULT 'bank_transfer' CHECK (method IN ('bank_transfer')),
  details_enc    text NOT NULL,                                -- JSON {holder, account_number, bank_code}: field-level encrypted, reads audit-logged
  last4          text NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected','superseded')),
  decided_by     uuid REFERENCES users,
  decided_at     timestamptz,
  decision_reason text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
-- one live (pending or verified) account per seller and currency; replacing it supersedes the old one, which is kept
CREATE UNIQUE INDEX payout_accounts_live ON payout_accounts (owner_id, currency) WHERE status IN ('pending','verified');
CREATE INDEX payout_accounts_review ON payout_accounts (created_at) WHERE status = 'pending';

-- ---------------------------------------------------------------- payouts (money sent to a seller)
CREATE TABLE provider_payouts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id       uuid NOT NULL REFERENCES users,
  currency        text NOT NULL,
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  status          text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','paid','failed')),
  account_id      uuid NOT NULL REFERENCES payout_accounts,
  idempotency_key text NOT NULL UNIQUE,
  reference       text,                                        -- bank / transfer reference once paid
  failure_code    text CHECK (failure_code IN ('invalid_account','account_closed','bank_rejected','name_mismatch','other')),
  failure_reason  text,
  created_by      uuid NOT NULL REFERENCES users,
  decided_by      uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz
);
CREATE INDEX provider_payouts_seller ON provider_payouts (seller_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX provider_payouts_reference ON provider_payouts (reference) WHERE reference IS NOT NULL;
-- at most one payout in flight per seller and currency
CREATE UNIQUE INDEX provider_payouts_one_open ON provider_payouts (seller_id, currency) WHERE status = 'processing';

-- ---------------------------------------------------------------- the ledger (append-only)
CREATE TABLE provider_ledger (
  id              bigserial PRIMARY KEY,
  seller_id       uuid NOT NULL REFERENCES users,
  currency        text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('sale','commission','refund','commission_reversal','chargeback','payout','payout_reversal')),
  amount_cents    bigint NOT NULL,                             -- signed effect on what the platform owes the seller
  gross_cents     bigint,                                      -- sale / refund / chargeback: the customer-facing amount this line is about (signed)
  tax_cents       bigint NOT NULL DEFAULT 0,                   -- tax contained in gross_cents (signed); informational, the seller remits it
  commission_bp   int,
  payment_id      uuid REFERENCES payments,
  purpose_type    text,
  purpose_id      uuid,
  payout_id       uuid REFERENCES provider_payouts,
  available_at    timestamptz,                                 -- sale / commission lines are payable from here on (hold period); NULL = immediately
  idempotency_key text NOT NULL UNIQUE,                        -- replays of a provider event or retried request cannot post twice
  memo            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provider_ledger_seller ON provider_ledger (seller_id, currency, id DESC);
CREATE INDEX provider_ledger_payment ON provider_ledger (payment_id) WHERE payment_id IS NOT NULL;

-- corrections are new compensating lines, never edits
CREATE FUNCTION provider_ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'provider_ledger is append-only: post a compensating entry instead'; END $$;
CREATE TRIGGER provider_ledger_no_update BEFORE UPDATE OR DELETE ON provider_ledger FOR EACH ROW EXECUTE FUNCTION provider_ledger_append_only();

-- ---------------------------------------------------------------- holds (disputes, reviews): held money is not payable
CREATE TABLE settlement_holds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id    uuid NOT NULL REFERENCES users,
  currency     text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  reason       text NOT NULL,
  payment_id   uuid REFERENCES payments,
  case_id      uuid REFERENCES cases,
  placed_by    uuid REFERENCES users,                          -- NULL: placed automatically from a verified provider event
  released_by  uuid REFERENCES users,
  release_reason text,
  released_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX settlement_holds_open ON settlement_holds (seller_id, currency) WHERE released_at IS NULL;

-- ---------------------------------------------------------------- exceptions the platform team works through
CREATE TABLE settlement_exceptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('paid_without_ledger','amount_mismatch','refund_unrecorded','provider_dispute','payout_failed','ledger_drift','share_mismatch')),
  dedupe_key   text NOT NULL,
  seller_id    uuid REFERENCES users,
  payment_id   uuid REFERENCES payments,
  payout_id    uuid REFERENCES provider_payouts,
  currency     text,
  amount_cents bigint,
  detail       jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution   text,
  resolved_by  uuid REFERENCES users,
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX settlement_exceptions_open ON settlement_exceptions (dedupe_key) WHERE status = 'open';
CREATE INDEX settlement_exceptions_queue ON settlement_exceptions (status, created_at DESC);

-- ---------------------------------------------------------------- provider events already handled (webhook replays are acknowledged, not re-applied)
CREATE TABLE provider_events (
  provider    text NOT NULL,
  event_id    text NOT NULL,
  kind        text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);
