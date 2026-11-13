BEGIN;
-- Ageing index for receivables summary queries on physio_invoices
CREATE INDEX IF NOT EXISTS physio_invoices_ageing_idx
  ON physio_invoices(provider_id, due_date, status)
  WHERE archived_at IS NULL;
COMMIT;
