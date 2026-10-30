-- Unified Finance control plane (#564). One canonical, append-only record of every money movement across all modules.
-- Additive only: nothing is dropped, rewritten or narrowed. Existing payments / invoices / provider_ledger stay the source of the
-- movement; every write path posts one canonical row here (idempotent), and `reconcile` backfills anything that predates it.

CREATE TABLE fin_transactions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           text NOT NULL CHECK (kind IN ('charge','payment','refund','credit_note','chargeback','payout','payout_reversal','adjustment')),
  status         text NOT NULL DEFAULT 'settled' CHECK (status IN ('open','settled','failed','cancelled','disputed','reversed')),
  source_module  text NOT NULL,                                  -- registration, venue, coaching, health, shop, sponsorship, suppliers, travel, wallet, ...
  source_type    text NOT NULL,                                  -- the purpose / object type that caused it (payments.purpose_type)
  source_id      uuid,                                           -- the object in its own module (order, invoice, charge, hire ...)
  payer_id       uuid REFERENCES users,
  payee_id       uuid REFERENCES users,
  payer_org_id   uuid REFERENCES organisations,                  -- the entity paying / receiving, when it is an organisation
  payee_org_id   uuid REFERENCES organisations,
  currency       text NOT NULL,
  gross_minor    bigint NOT NULL CHECK (gross_minor >= 0),       -- amounts are positive; the kind gives the direction
  tax_minor      bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),        -- tax contained in gross (informational, never tax advice)
  fee_minor      bigint NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),        -- platform / provider fee taken from the payee
  discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  net_minor      bigint NOT NULL,                                -- gross - tax - fee (what the payee keeps before tax remittance)
  provider       text,
  provider_ref   text,
  payment_id     uuid REFERENCES payments,
  payout_id      uuid REFERENCES provider_payouts,
  parent_id      uuid REFERENCES fin_transactions,               -- a refund / chargeback points at the payment it reverses
  idem_key       text NOT NULL UNIQUE,                           -- a replayed webhook / retried request cannot post twice
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  meta           jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX fin_tx_payee_org  ON fin_transactions (payee_org_id, occurred_at DESC) WHERE payee_org_id IS NOT NULL;
CREATE INDEX fin_tx_payer_org  ON fin_transactions (payer_org_id, occurred_at DESC) WHERE payer_org_id IS NOT NULL;
CREATE INDEX fin_tx_payee      ON fin_transactions (payee_id, occurred_at DESC) WHERE payee_id IS NOT NULL;
CREATE INDEX fin_tx_payer      ON fin_transactions (payer_id, occurred_at DESC) WHERE payer_id IS NOT NULL;
CREATE INDEX fin_tx_payment    ON fin_transactions (payment_id) WHERE payment_id IS NOT NULL;
CREATE INDEX fin_tx_source     ON fin_transactions (source_type, source_id);
CREATE INDEX fin_tx_module     ON fin_transactions (source_module, occurred_at DESC);
CREATE INDEX fin_tx_open       ON fin_transactions (kind, status) WHERE status IN ('open','disputed');

-- money never changes after it is posted: only the lifecycle status may move (open charge -> settled, disputed -> reversed ...)
CREATE FUNCTION fin_transactions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'fin_transactions is append-only: post a compensating entry instead'; END IF;
  IF NEW.kind <> OLD.kind OR NEW.currency <> OLD.currency OR NEW.gross_minor <> OLD.gross_minor OR NEW.tax_minor <> OLD.tax_minor
     OR NEW.fee_minor <> OLD.fee_minor OR NEW.discount_minor <> OLD.discount_minor OR NEW.net_minor <> OLD.net_minor
     OR NEW.source_type <> OLD.source_type OR NEW.idem_key <> OLD.idem_key OR NEW.payment_id IS DISTINCT FROM OLD.payment_id
     OR NEW.payer_id IS DISTINCT FROM OLD.payer_id OR NEW.payee_id IS DISTINCT FROM OLD.payee_id THEN
    RAISE EXCEPTION 'fin_transactions amounts and parties cannot be edited: post a compensating entry instead';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fin_transactions_guard BEFORE UPDATE OR DELETE ON fin_transactions FOR EACH ROW EXECUTE FUNCTION fin_transactions_guard();

-- who did what to a transaction (status changes, reads of a detail, exports); append-only like the ledger
CREATE TABLE fin_tx_events (
  id         bigserial PRIMARY KEY,
  tx_id      uuid NOT NULL REFERENCES fin_transactions,
  actor_id   uuid REFERENCES users,
  action     text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fin_tx_events_tx ON fin_tx_events (tx_id, id);
CREATE FUNCTION fin_tx_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'fin_tx_events is append-only'; END $$;
CREATE TRIGGER fin_tx_events_guard BEFORE UPDATE OR DELETE ON fin_tx_events FOR EACH ROW EXECUTE FUNCTION fin_tx_events_guard();

-- canonical-ledger reconciliation: where the canonical record and the provider payment record disagree. (Provider-ledger problems
-- such as amount mismatches, disputes and failed payouts stay in settlement_exceptions; the console lists both in one queue.)
CREATE TABLE fin_recon_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('payment_unrecorded','refund_drift','amount_drift')),
  dedupe_key  text NOT NULL,
  payment_id  uuid REFERENCES payments,
  currency    text,
  amount_minor bigint,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  detail      jsonb NOT NULL DEFAULT '{}',
  resolution  text,
  resolved_by uuid REFERENCES users,
  resolved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX fin_recon_open ON fin_recon_items (dedupe_key) WHERE status = 'open';
CREATE INDEX fin_recon_status ON fin_recon_items (status, created_at DESC);
