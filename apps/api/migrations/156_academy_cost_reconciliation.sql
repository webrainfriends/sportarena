-- Academy cost & revenue reconciliation (#787). Additive and backwards-compatible: nothing is dropped, narrowed or rewritten.
--  * The reconciliation queue is the shared Finance queue (fin_recon_items, #564/#593), widened with academy cost/revenue kinds, a 'disputed' state and the
--    source record each item points at. It is not a second queue and not a ledger: no invoice, payment, settlement or payroll row is created or changed.
--  * A human correction is an append-only attribution decision (academy_cost_attributions); the canonical record it is about is never touched. The newest
--    decision for a source wins, and `version` is the organisation's cost-allocation version that every P&L reports.
--  * A supplier request records when it was delivered and the invoice it was billed on, so its actual cost can reach the P&L on a real date.
ALTER TABLE fin_recon_items DROP CONSTRAINT IF EXISTS fin_recon_items_kind_check;
ALTER TABLE fin_recon_items ADD CONSTRAINT fin_recon_items_kind_check CHECK (kind IN ('payment_unrecorded','refund_drift','amount_drift',
  'cost_unlinked','revenue_unlinked','double_count_risk','supplier_unmatched','supplier_variance','venue_unbooked','payroll_unpriced','currency_mismatch'));
ALTER TABLE fin_recon_items DROP CONSTRAINT IF EXISTS fin_recon_items_status_check;
ALTER TABLE fin_recon_items ADD CONSTRAINT fin_recon_items_status_check CHECK (status IN ('open','disputed','resolved'));
ALTER TABLE fin_recon_items ADD COLUMN IF NOT EXISTS domain text NOT NULL DEFAULT 'finance';          -- 'finance' (payment drift) | 'academy_cost'
ALTER TABLE fin_recon_items ADD COLUMN IF NOT EXISTS source_type text;
ALTER TABLE fin_recon_items ADD COLUMN IF NOT EXISTS source_id uuid;
ALTER TABLE fin_recon_items ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES academy_branches;
ALTER TABLE fin_recon_items ADD COLUMN IF NOT EXISTS history jsonb NOT NULL DEFAULT '[]';
ALTER TABLE fin_recon_items ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS fin_recon_disputed ON fin_recon_items (dedupe_key) WHERE status = 'disputed';
CREATE INDEX IF NOT EXISTS fin_recon_org ON fin_recon_items (organisation_id, status, created_at DESC) WHERE organisation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fin_recon_dedupe ON fin_recon_items (dedupe_key);

CREATE TABLE IF NOT EXISTS academy_cost_attributions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  source_type     text NOT NULL CHECK (source_type IN ('academy_payroll_line','academy_supplier_request','academy_cost_entry','academy_charge')),
  source_id       uuid NOT NULL,
  decision        text NOT NULL CHECK (decision IN ('programme','overhead','keep_canonical','keep_manual')),
  programme_id    uuid REFERENCES academy_programmes,
  cohort_id       uuid REFERENCES org_cohorts,
  overhead_method text CHECK (overhead_method IN ('participants','revenue_share')),
  recon_item_id   uuid REFERENCES fin_recon_items,
  reason          text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  version         bigint NOT NULL,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (decision <> 'programme' OR programme_id IS NOT NULL),
  CHECK (decision <> 'overhead' OR overhead_method IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS academy_cost_attr_source ON academy_cost_attributions (organisation_id, source_type, source_id, version DESC);
CREATE UNIQUE INDEX IF NOT EXISTS academy_cost_attr_version ON academy_cost_attributions (organisation_id, version);
CREATE OR REPLACE FUNCTION academy_cost_attr_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'academy_cost_attributions is append-only: record a new decision instead'; END $$;
DROP TRIGGER IF EXISTS academy_cost_attr_guard ON academy_cost_attributions;
CREATE TRIGGER academy_cost_attr_guard BEFORE UPDATE OR DELETE ON academy_cost_attributions FOR EACH ROW EXECUTE FUNCTION academy_cost_attr_guard();

ALTER TABLE academy_supplier_requests ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
ALTER TABLE academy_supplier_requests ADD COLUMN IF NOT EXISTS invoice_ref text;
UPDATE academy_supplier_requests SET delivered_at = updated_at WHERE delivered_at IS NULL AND status IN ('delivered','done');   -- backfill: the last change is the best date known
