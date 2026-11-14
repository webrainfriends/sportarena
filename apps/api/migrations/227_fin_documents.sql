-- Finance Stage 2: invoices, credit notes, allocations, instalments, deposits, offline receipts (#564)
BEGIN;

CREATE TABLE IF NOT EXISTS fin_invoice_counters (
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  prefix          text NOT NULL DEFAULT 'INV',
  next_seq        integer NOT NULL DEFAULT 1,
  PRIMARY KEY (organisation_id, prefix)
);

CREATE TABLE IF NOT EXISTS fin_invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  number          text NOT NULL,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','partial','paid','void','overdue')),
  currency        char(3) NOT NULL,
  issue_date      date NOT NULL DEFAULT CURRENT_DATE,
  due_date        date,
  customer_id     uuid REFERENCES users(id),
  customer_org_id uuid REFERENCES organisations(id),
  billing_name_enc  text,
  billing_email_enc text,
  billing_address_enc text,
  subtotal        numeric(14,2) NOT NULL DEFAULT 0,
  tax_amount      numeric(14,2) NOT NULL DEFAULT 0,
  discount_amount numeric(14,2) NOT NULL DEFAULT 0,
  total           numeric(14,2) NOT NULL DEFAULT 0,
  amount_paid     numeric(14,2) NOT NULL DEFAULT 0,
  amount_due      numeric(14,2) GENERATED ALWAYS AS (total - amount_paid) STORED,
  notes_enc       text,
  reference       text,
  event_id        uuid,
  team_id         uuid,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  paid_at         timestamptz,
  voided_at       timestamptz,
  tx_id           uuid,
  UNIQUE (organisation_id, number)
);

CREATE TABLE IF NOT EXISTS fin_invoice_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  uuid NOT NULL REFERENCES fin_invoices(id),
  position    integer NOT NULL DEFAULT 0,
  description text NOT NULL,
  quantity    numeric(10,3) NOT NULL DEFAULT 1,
  unit_price  numeric(14,2) NOT NULL DEFAULT 0,
  tax_rate_bp integer NOT NULL DEFAULT 0,
  tax_amount  numeric(14,2) NOT NULL DEFAULT 0,
  line_total  numeric(14,2) NOT NULL DEFAULT 0,
  source_type text,
  source_id   uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fin_credit_notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  number          text NOT NULL,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','applied','void')),
  currency        char(3) NOT NULL,
  issue_date      date NOT NULL DEFAULT CURRENT_DATE,
  customer_id     uuid REFERENCES users(id),
  customer_org_id uuid REFERENCES organisations(id),
  invoice_id      uuid REFERENCES fin_invoices(id),
  reason          text,
  subtotal        numeric(14,2) NOT NULL DEFAULT 0,
  tax_amount      numeric(14,2) NOT NULL DEFAULT 0,
  total           numeric(14,2) NOT NULL DEFAULT 0,
  amount_applied  numeric(14,2) NOT NULL DEFAULT 0,
  amount_remaining numeric(14,2) GENERATED ALWAYS AS (total - amount_applied) STORED,
  notes_enc       text,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  tx_id           uuid,
  UNIQUE (organisation_id, number)
);

CREATE TABLE IF NOT EXISTS fin_credit_note_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_note_id uuid NOT NULL REFERENCES fin_credit_notes(id),
  position       integer NOT NULL DEFAULT 0,
  description    text NOT NULL,
  quantity       numeric(10,3) NOT NULL DEFAULT 1,
  unit_price     numeric(14,2) NOT NULL DEFAULT 0,
  tax_rate_bp    integer NOT NULL DEFAULT 0,
  tax_amount     numeric(14,2) NOT NULL DEFAULT 0,
  line_total     numeric(14,2) NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fin_allocations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_note_id uuid NOT NULL REFERENCES fin_credit_notes(id),
  invoice_id     uuid NOT NULL REFERENCES fin_invoices(id),
  amount         numeric(14,2) NOT NULL,
  allocated_at   timestamptz NOT NULL DEFAULT now(),
  allocated_by   uuid REFERENCES users(id),
  UNIQUE (credit_note_id, invoice_id)
);

CREATE TABLE IF NOT EXISTS fin_instalments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  invoice_id      uuid REFERENCES fin_invoices(id),
  customer_id     uuid REFERENCES users(id),
  currency        char(3) NOT NULL,
  total_amount    numeric(14,2) NOT NULL,
  amount_paid     numeric(14,2) NOT NULL DEFAULT 0,
  amount_due      numeric(14,2) GENERATED ALWAYS AS (total_amount - amount_paid) STORED,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled','defaulted')),
  schedule_type   text NOT NULL DEFAULT 'monthly' CHECK (schedule_type IN ('weekly','fortnightly','monthly','custom')),
  start_date      date NOT NULL,
  end_date        date,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fin_instalment_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instalment_id uuid NOT NULL REFERENCES fin_instalments(id),
  position      integer NOT NULL DEFAULT 0,
  due_date      date NOT NULL,
  amount        numeric(14,2) NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','overdue','waived')),
  paid_at       timestamptz,
  paid_amount   numeric(14,2),
  tx_id         uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fin_deposits (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  uuid NOT NULL REFERENCES organisations(id),
  customer_id      uuid REFERENCES users(id),
  currency         char(3) NOT NULL,
  amount           numeric(14,2) NOT NULL,
  amount_held      numeric(14,2) NOT NULL DEFAULT 0,
  amount_released  numeric(14,2) NOT NULL DEFAULT 0,
  amount_forfeited numeric(14,2) NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','received','partially_released','released','forfeited')),
  purpose          text,
  reference        text,
  received_at      timestamptz,
  release_due_at   date,
  released_at      timestamptz,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  receipt_tx_id    uuid,
  release_tx_id    uuid
);

CREATE TABLE IF NOT EXISTS fin_offline_receipts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  receipt_number  text NOT NULL,
  invoice_id      uuid REFERENCES fin_invoices(id),
  instalment_id   uuid REFERENCES fin_instalments(id),
  customer_id     uuid REFERENCES users(id),
  currency        char(3) NOT NULL,
  amount          numeric(14,2) NOT NULL,
  method          text NOT NULL DEFAULT 'cash' CHECK (method IN ('cash','bank_transfer','cheque','upi','other')),
  reference_enc   text,
  notes_enc       text,
  received_at     timestamptz NOT NULL DEFAULT now(),
  received_by     uuid REFERENCES users(id),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','bounced','reversed')),
  confirmed_at    timestamptz,
  confirmed_by    uuid REFERENCES users(id),
  tx_id           uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, receipt_number)
);

CREATE INDEX IF NOT EXISTS fin_invoices_org_status   ON fin_invoices(organisation_id, status);
CREATE INDEX IF NOT EXISTS fin_invoices_org_date     ON fin_invoices(organisation_id, issue_date DESC);
CREATE INDEX IF NOT EXISTS fin_invoices_customer     ON fin_invoices(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fin_invoice_lines_inv     ON fin_invoice_lines(invoice_id);
CREATE INDEX IF NOT EXISTS fin_credit_notes_org_date ON fin_credit_notes(organisation_id, issue_date DESC);
CREATE INDEX IF NOT EXISTS fin_credit_notes_inv      ON fin_credit_notes(invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fin_allocations_cn        ON fin_allocations(credit_note_id);
CREATE INDEX IF NOT EXISTS fin_allocations_inv       ON fin_allocations(invoice_id);
CREATE INDEX IF NOT EXISTS fin_instalments_org       ON fin_instalments(organisation_id);
CREATE INDEX IF NOT EXISTS fin_instalments_customer  ON fin_instalments(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fin_instalment_items_plan ON fin_instalment_items(instalment_id, due_date);
CREATE INDEX IF NOT EXISTS fin_deposits_org          ON fin_deposits(organisation_id);
CREATE INDEX IF NOT EXISTS fin_deposits_customer     ON fin_deposits(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fin_offline_receipts_org  ON fin_offline_receipts(organisation_id, received_at DESC);
CREATE INDEX IF NOT EXISTS fin_offline_receipts_inv  ON fin_offline_receipts(invoice_id) WHERE invoice_id IS NOT NULL;

CREATE OR REPLACE FUNCTION fin_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['fin_invoices','fin_credit_notes','fin_instalments','fin_deposits','fin_offline_receipts']) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'fin_updated_at_' || t
        AND tgrelid = t::regclass
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER fin_updated_at_%I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION fin_set_updated_at()',
        t, t
      );
    END IF;
  END LOOP;
END $$;

COMMIT;
