BEGIN;
CREATE TABLE IF NOT EXISTS physio_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number text NOT NULL,
  provider_id uuid NOT NULL REFERENCES users(id),
  patient_id uuid NOT NULL REFERENCES users(id),
  appointment_id uuid REFERENCES appointments(id),
  currency text NOT NULL DEFAULT 'AUD',
  subtotal_cents bigint NOT NULL DEFAULT 0,
  tax_cents bigint NOT NULL DEFAULT 0,
  total_cents bigint NOT NULL DEFAULT 0,
  tax_class text NOT NULL DEFAULT 'unspecified',
  tax_rate_bp integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft',
  due_date date,
  paid_at timestamptz,
  payment_method text,
  notes_enc text,
  line_items jsonb NOT NULL DEFAULT '[]',
  issued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE(provider_id, invoice_number)
);
CREATE INDEX IF NOT EXISTS physio_invoices_provider_idx ON physio_invoices(provider_id);
CREATE INDEX IF NOT EXISTS physio_invoices_patient_idx ON physio_invoices(patient_id);
CREATE INDEX IF NOT EXISTS physio_invoices_status_idx ON physio_invoices(provider_id, status) WHERE archived_at IS NULL;
COMMIT;
