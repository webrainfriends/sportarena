-- Finance control plane, remaining gaps (#593): venue invoices as obligations, player-contract money, and the per-entity tax engine.
-- Additive only: nothing is dropped, rewritten or narrowed. (The tax-engine tables are added further down.)

-- 1. venue invoices: a due date, so an open invoice ages like every other receivable. Set when the invoice is raised; backfilled for existing ones from the
-- reservation's payment deadline, else the first booking's start, else the issue date.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS due_on date;
UPDATE invoices i SET due_on = coalesce(
    (SELECT r.payment_deadline::date FROM reservations r WHERE r.id = i.reservation_id),
    (SELECT min(b.starts_at)::date FROM bookings b WHERE b.reservation_id = i.reservation_id),
    i.issued_at::date)
  WHERE i.due_on IS NULL AND i.kind = 'invoice';
CREATE INDEX IF NOT EXISTS invoices_open_due ON invoices (due_on) WHERE kind = 'invoice' AND status = 'open';

-- 3. per-entity tax engine. An organisation's tax profile (regime, registration status, how it rounds) and effective-dated rules (rate and treatment per
-- ledger category or source). The ledger records how each figure was derived. Rules are never deleted: one is ended by giving it an end date.
-- The registration number itself stays where it already is (organisations.tax_id).
CREATE TABLE IF NOT EXISTS org_tax_profiles (
  organisation_id uuid PRIMARY KEY REFERENCES organisations,
  regime          text NOT NULL DEFAULT 'none' CHECK (regime IN ('none','gst_in','vat','sales_tax')),
  registered      boolean NOT NULL DEFAULT false,
  rounding_mode   text NOT NULL DEFAULT 'half_up' CHECK (rounding_mode IN ('half_up','half_even')),
  updated_by      uuid REFERENCES users,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS org_tax_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  category        text NOT NULL DEFAULT '*',          -- a fin_transactions.category, or '*' for every category
  source_type     text,                               -- optional narrowing to one source (team_charge, sponsorship_obligation ...)
  code            text NOT NULL CHECK (length(code) BETWEEN 1 AND 20),     -- e.g. GST18, VAT20, EXEMPT
  treatment       text NOT NULL DEFAULT 'standard' CHECK (treatment IN ('standard','zero_rated','exempt','out_of_scope','reverse_charge')),
  rate_bp         int  NOT NULL DEFAULT 0 CHECK (rate_bp BETWEEN 0 AND 10000),
  withholding_bp  int  NOT NULL DEFAULT 0 CHECK (withholding_bp BETWEEN 0 AND 5000),
  effective_from  date NOT NULL,
  effective_to    date,
  evidence        text CHECK (evidence IS NULL OR length(evidence) <= 500),   -- where the rate comes from, as provider_tax_rates does
  created_by      uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (treatment = 'standard' OR rate_bp = 0)
);
CREATE INDEX IF NOT EXISTS org_tax_rules_lookup ON org_tax_rules (organisation_id, category, effective_from DESC);

-- how each ledger figure was derived: the rule's code, rate and treatment, and whether the tax came from the source module, this engine, or a share of a charge.
-- Withholding (deducted from a payee) is its own amount, never mixed into tax. The append-only guard still refuses any change to kind, amounts, parties and tax_minor.
ALTER TABLE fin_transactions ADD COLUMN IF NOT EXISTS tax_rate_bp int;
ALTER TABLE fin_transactions ADD COLUMN IF NOT EXISTS tax_code text;
ALTER TABLE fin_transactions ADD COLUMN IF NOT EXISTS tax_treatment text;
ALTER TABLE fin_transactions ADD COLUMN IF NOT EXISTS tax_basis text CHECK (tax_basis IS NULL OR tax_basis IN ('source','engine','prorata'));
ALTER TABLE fin_transactions ADD COLUMN IF NOT EXISTS withheld_minor bigint NOT NULL DEFAULT 0 CHECK (withheld_minor >= 0);
-- rows posted before this change carried withholding in tax_minor; copy it across (tax_minor itself is immutable and stays; reports read withholding sources from withheld_minor)
UPDATE fin_transactions SET withheld_minor = tax_minor WHERE source_type IN ('payout_item','player_payout_line') AND withheld_minor = 0 AND tax_minor > 0;
CREATE INDEX IF NOT EXISTS fin_tx_tax_report ON fin_transactions (payee_org_id, occurred_at) WHERE kind IN ('payment','refund');
