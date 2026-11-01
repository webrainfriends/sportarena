-- One executable payout path (#701): officials fees, venue settlements and coach/provider balances are paid through the same batch.
-- Additive only: new tables and nullable columns, nothing is dropped, rewritten or narrowed.

CREATE SEQUENCE IF NOT EXISTS payout_batch_no_seq;

-- Platform-wide rules per currency (a currency with no row uses: no withholding, no fee, every batch needs a second approver).
CREATE TABLE IF NOT EXISTS payout_settings (
  currency                  text PRIMARY KEY CHECK (currency ~ '^[A-Z]{3}$'),
  withholding_bp            integer NOT NULL DEFAULT 0 CHECK (withholding_bp BETWEEN 0 AND 10000),   -- tax withheld from official fees and venue settlements
  fee_bp                    integer NOT NULL DEFAULT 0 CHECK (fee_bp BETWEEN 0 AND 10000),           -- payout fee, basis points
  fee_flat_minor            bigint  NOT NULL DEFAULT 0 CHECK (fee_flat_minor >= 0),                  -- payout fee, flat per item
  approval_threshold_minor  bigint  CHECK (approval_threshold_minor IS NULL OR approval_threshold_minor >= 0), -- at or below: the maker may approve. NULL = a second person always approves
  updated_by                uuid REFERENCES users,
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payout_batches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_no        bigint NOT NULL DEFAULT nextval('payout_batch_no_seq'),
  currency        text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  rail            text NOT NULL DEFAULT 'bank_file' CHECK (rail IN ('bank_file','stripe')),
  status          text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval','approved','exported','executing','closed','cancelled')),
  client_key      text NOT NULL UNIQUE,                       -- idempotency: the same key returns the same batch
  gross_minor     bigint NOT NULL DEFAULT 0,
  tax_minor       bigint NOT NULL DEFAULT 0,                  -- withheld
  fee_minor       bigint NOT NULL DEFAULT 0,
  net_minor       bigint NOT NULL DEFAULT 0,                  -- what the banks receive
  approval_basis  text CHECK (approval_basis IN ('second_person','below_threshold','sole_authority')),
  created_by      uuid NOT NULL REFERENCES users,
  approved_by     uuid REFERENCES users,
  approved_at     timestamptz,
  closed_at       timestamptz,
  row_version     integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payout_batches_status ON payout_batches (status, created_at DESC);

CREATE TABLE IF NOT EXISTS payout_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id           uuid NOT NULL REFERENCES payout_batches,
  source_type        text NOT NULL CHECK (source_type IN ('official_fee','venue_settlement','provider_balance')),
  source_id          uuid,                                    -- fixture_officials.id / settlements.id; NULL for a provider balance
  payee_id           uuid NOT NULL REFERENCES users,
  account_id         uuid NOT NULL REFERENCES payout_accounts,
  currency           text NOT NULL,
  gross_minor        bigint NOT NULL CHECK (gross_minor > 0),
  tax_minor          bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  fee_minor          bigint NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  net_minor          bigint NOT NULL CHECK (net_minor > 0),
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','cancelled')),
  attempt            integer NOT NULL DEFAULT 1,
  idem_key           text NOT NULL UNIQUE,                    -- per attempt; also the provider transfer idempotency key
  reference          text,
  failure_code       text CHECK (failure_code IN ('invalid_account','account_closed','bank_rejected','name_mismatch','other')),
  failure_reason     text,
  provider_payout_id uuid REFERENCES provider_payouts,        -- provider_balance items debit the seller ledger through the existing payout
  decided_by         uuid REFERENCES users,
  decided_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payout_items_batch ON payout_items (batch_id);
CREATE INDEX IF NOT EXISTS payout_items_payee ON payout_items (payee_id, created_at DESC);
-- an obligation is settled once: one live (pending or paid) item per source
CREATE UNIQUE INDEX IF NOT EXISTS payout_items_one_live_source ON payout_items (source_type, source_id) WHERE source_id IS NOT NULL AND status IN ('pending','paid');
-- a provider balance: one pending item per seller and currency
CREATE UNIQUE INDEX IF NOT EXISTS payout_items_one_live_balance ON payout_items (payee_id, currency) WHERE source_type = 'provider_balance' AND status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS payout_items_reference ON payout_items (reference) WHERE reference IS NOT NULL AND status = 'paid';

CREATE TABLE IF NOT EXISTS payout_events (
  id        bigserial PRIMARY KEY,
  batch_id  uuid NOT NULL REFERENCES payout_batches,
  item_id   uuid REFERENCES payout_items,
  actor_id  uuid REFERENCES users,
  action    text NOT NULL,
  detail    jsonb NOT NULL DEFAULT '{}',
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payout_events_batch ON payout_events (batch_id, id);
CREATE OR REPLACE FUNCTION payout_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'payout_events is append-only'; END $$;
DROP TRIGGER IF EXISTS payout_events_no_change ON payout_events;
CREATE TRIGGER payout_events_no_change BEFORE UPDATE OR DELETE ON payout_events FOR EACH ROW EXECUTE FUNCTION payout_events_append_only();

-- links from the old records to the payout that settled them
ALTER TABLE fixture_officials         ADD COLUMN IF NOT EXISTS payout_item_id uuid REFERENCES payout_items;
ALTER TABLE fixture_official_pay_log  ADD COLUMN IF NOT EXISTS payout_item_id uuid REFERENCES payout_items;
ALTER TABLE settlements               ADD COLUMN IF NOT EXISTS payout_item_id uuid REFERENCES payout_items;
