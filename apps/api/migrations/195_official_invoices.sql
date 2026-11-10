-- #1008 Referee invoices, expenses and settlement
-- Additive only: no DROP, TRUNCATE, or narrowing ALTER.

-- Global invoice counter series for official invoices (kind is the unique key)
CREATE TABLE IF NOT EXISTS official_invoice_counters (
  kind     text PRIMARY KEY,
  prefix   text NOT NULL,
  next_seq bigint NOT NULL DEFAULT 1
);
INSERT INTO official_invoice_counters (kind, prefix, next_seq)
VALUES ('official_self', 'REF', 1), ('official_rci', 'RCI', 1)
ON CONFLICT DO NOTHING;

-- Core invoice entity
CREATE TABLE official_invoices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_official_id uuid NOT NULL REFERENCES fixture_officials(id),
  invoice_id          uuid REFERENCES invoices(id),
  organisation_id     uuid NOT NULL,
  official_id         uuid NOT NULL,
  currency            char(3) NOT NULL,
  total_minor         bigint NOT NULL DEFAULT 0,
  tax_minor           bigint NOT NULL DEFAULT 0,
  net_minor           bigint NOT NULL DEFAULT 0,
  withholding_minor   bigint NOT NULL DEFAULT 0,
  kind                text NOT NULL CHECK (kind IN ('self_issued','rci')),
  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','submitted','approved','queried','disputed','void')),
  rci_confirmed_at    timestamptz,
  rci_rejected_at     timestamptz,
  invoice_number      text,
  invoice_pdf_doc_id  uuid,
  invoice_pdf_sha256  text,
  buyer_snapshot_enc  bytea,
  seller_snapshot_enc bytea,
  idempotency_key     text UNIQUE,
  submitted_at        timestamptz,
  approved_at         timestamptz,
  voided_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON official_invoices (fixture_official_id);
CREATE INDEX ON official_invoices (official_id, status);
CREATE INDEX ON official_invoices (organisation_id, status);
CREATE INDEX ON official_invoices (invoice_id) WHERE invoice_id IS NOT NULL;

-- Append-only audit trail
CREATE TABLE official_invoice_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  official_invoice_id uuid NOT NULL REFERENCES official_invoices(id),
  event               text NOT NULL,
  actor_id            uuid,
  actor_role          text,
  meta                jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON official_invoice_events (official_invoice_id, created_at);

-- Partial payment tracking (prevents double-pay on webhook replay via unique index)
CREATE TABLE official_invoice_payout_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  official_invoice_id uuid NOT NULL REFERENCES official_invoices(id),
  payout_item_id      uuid NOT NULL,
  amount_minor        bigint NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON official_invoice_payout_items (official_invoice_id, payout_item_id);

-- Withholding tax per invoice
CREATE TABLE official_withholding (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  official_invoice_id uuid NOT NULL REFERENCES official_invoices(id) UNIQUE,
  official_id         uuid NOT NULL,
  organisation_id     uuid NOT NULL,
  currency            char(3) NOT NULL,
  gross_minor         bigint NOT NULL,
  rate_bps            int NOT NULL,
  withheld_minor      bigint NOT NULL,
  jurisdiction        text,
  remitted_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Expense claims (per assignment)
CREATE TABLE official_expenses (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_official_id     uuid NOT NULL REFERENCES fixture_officials(id),
  official_id             uuid NOT NULL,
  organisation_id         uuid NOT NULL,
  batch_id                uuid,
  currency                char(3) NOT NULL,
  amount_minor            bigint NOT NULL,
  category                text NOT NULL CHECK (category IN ('travel','accommodation','subsistence','equipment','other')),
  description_enc         bytea,
  receipt_doc_id          uuid,
  status                  text NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','submitted','approved','rejected')),
  idempotency_key         text UNIQUE,
  submitted_at            timestamptz,
  approved_at             timestamptz,
  rejected_at             timestamptz,
  rejection_reason_enc    bytea,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON official_expenses (fixture_official_id);
CREATE INDEX ON official_expenses (official_id, status);

-- Expense batches (group approved expenses into one reimbursement request)
CREATE TABLE official_expense_batches (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  official_id         uuid NOT NULL,
  organisation_id     uuid NOT NULL,
  currency            char(3) NOT NULL,
  total_minor         bigint NOT NULL DEFAULT 0,
  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','submitted','approved','rejected','paid')),
  payout_item_id      uuid,
  idempotency_key     text UNIQUE,
  submitted_at        timestamptz,
  approved_at         timestamptz,
  paid_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON official_expense_batches (official_id, status);
CREATE INDEX ON official_expense_batches (organisation_id, status);

ALTER TABLE official_expenses
  ADD CONSTRAINT official_expenses_batch_id_fk
  FOREIGN KEY (batch_id) REFERENCES official_expense_batches(id);
CREATE INDEX ON official_expenses (batch_id) WHERE batch_id IS NOT NULL;

-- Link approved invoice / expense batch to the assignment
ALTER TABLE fixture_officials
  ADD COLUMN IF NOT EXISTS official_invoice_id uuid REFERENCES official_invoices(id),
  ADD COLUMN IF NOT EXISTS expense_batch_id uuid REFERENCES official_expense_batches(id);
