-- Durable background processing (#61). Additive only: new tables + nullable columns, nothing is rewritten or dropped.
-- PostgreSQL stays authoritative: the jobs table is a transactional outbox / retry queue / dead-letter registry.

CREATE TABLE jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category     text NOT NULL,                                  -- holds | refunds | waitlist | loyalty | reminders | email | push | notify ...
  kind         text NOT NULL,                                  -- handler name, e.g. notify.retry, refund.credit_note, email.delivery
  dedupe_key   text,                                           -- makes enqueue idempotent per (kind, dedupe_key)
  payload      jsonb NOT NULL DEFAULT '{}',                    -- ids and non-sensitive parameters only
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','dead','requeued')),
  run_at       timestamptz NOT NULL DEFAULT now(),
  attempts     int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 6,
  leased_until timestamptz,                                    -- a running job whose lease expired is claimable again (crash recovery)
  claimed_by   text,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  dead_at      timestamptz
);
CREATE UNIQUE INDEX jobs_dedupe ON jobs (kind, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX jobs_due ON jobs (category, run_at) WHERE status IN ('queued','running');
CREATE INDEX jobs_dead ON jobs (dead_at DESC, id) WHERE status = 'dead';

-- Refund intent ledger: written BEFORE the provider is called, so a crash between "provider moved the money" and
-- "we recorded it" is retried with the same amount + idempotency key and can never move money twice.
CREATE TABLE refund_intents (
  invoice_id      uuid NOT NULL REFERENCES invoices,
  payment_id      uuid NOT NULL REFERENCES payments,
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  idempotency_key text NOT NULL,
  status          text NOT NULL DEFAULT 'intent' CHECK (status IN ('intent','recorded')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  recorded_at     timestamptz,
  PRIMARY KEY (invoice_id, payment_id)
);

ALTER TABLE invoices ADD COLUMN refund_next_attempt_at timestamptz;            -- exponential backoff for failed refunds
ALTER TABLE notification_deliveries ADD COLUMN claimed_at timestamptz;          -- lease for the dispatcher
ALTER TABLE notification_deliveries ADD COLUMN next_attempt_at timestamptz;     -- backoff
