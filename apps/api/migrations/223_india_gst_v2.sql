-- India GST v2: add GST/TDS detail columns to invoices and physio_invoices

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS document_type       VARCHAR(20) NOT NULL DEFAULT 'invoice',
  ADD COLUMN IF NOT EXISTS linked_invoice_id   UUID REFERENCES invoices(id),
  ADD COLUMN IF NOT EXISTS gst_detail          JSONB,
  ADD COLUMN IF NOT EXISTS tds_detail          JSONB,
  ADD COLUMN IF NOT EXISTS gst_issuer_snapshot JSONB;

COMMENT ON COLUMN invoices.document_type IS 'invoice|credit_note|debit_note|replacement';
COMMENT ON COLUMN invoices.gst_detail IS 'Frozen at issue: {cgst_cents,sgst_cents,igst_cents,place_of_supply,supply_type,hsn_sac_code,reverse_charge,tax_treatment,supplier_state,rate_bp}';
COMMENT ON COLUMN invoices.tds_detail IS 'Frozen at issue: {section_ref,rate_bp,basis_cents,withheld_cents,evidence_ref}';
COMMENT ON COLUMN invoices.gst_issuer_snapshot IS 'Frozen at issue: {gstin,legal_name,state_code,invoice_prefix,effective_at}';

ALTER TABLE physio_invoices
  ADD COLUMN IF NOT EXISTS gst_detail JSONB;
