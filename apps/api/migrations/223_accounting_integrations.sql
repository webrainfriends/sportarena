-- India Accounting Integrations (#513): Tally ERP, Zoho Books, export lifecycle, effective-dated ledger/tax mapping
-- and reconciliation layer. Additive only: no DROP, no TRUNCATE, no rewrite of existing columns.

-- Effective-dated ledger/tax/clearing/cost-centre mapping per provider per org.
-- Each row maps a source concept (product category, GST component, branch) to a provider chart-of-accounts entry.
-- Overlap prevention is enforced at the application layer (SELECT FOR UPDATE in tx) rather than a btree_gist exclusion,
-- to avoid a dependency on the btree_gist extension that may not be installed on all environments.
CREATE TABLE IF NOT EXISTS accounting_export_mappings (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID        NOT NULL REFERENCES organisations(id),
  provider       TEXT        NOT NULL,
  mapping_type   TEXT        NOT NULL
    CHECK (mapping_type IN ('ledger', 'tax', 'clearing', 'cost_centre')),
  source_key     TEXT        NOT NULL,
  target_account TEXT        NOT NULL,
  effective_from DATE        NOT NULL,
  effective_to   DATE,
  created_by     UUID        NOT NULL REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_acct_mappings_org_prov
  ON accounting_export_mappings(org_id, provider);
CREATE INDEX IF NOT EXISTS idx_acct_mappings_org_type
  ON accounting_export_mappings(org_id, provider, mapping_type, source_key);

-- Export lifecycle state machine: one row per (org, provider, document_type, document_id) triplet.
-- The UNIQUE constraint enforces idempotency at the table level: a retry updates the existing row.
CREATE TABLE IF NOT EXISTS accounting_exports (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID        NOT NULL REFERENCES organisations(id),
  provider         TEXT        NOT NULL,
  document_type    TEXT        NOT NULL
    CHECK (document_type IN ('invoice', 'credit_note', 'payment', 'journal')),
  document_id      UUID        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'eligible'
    CHECK (status IN ('eligible', 'queued', 'exported', 'reconciled', 'failed', 'review')),
  payload_hash     TEXT,
  payload_version  INTEGER     NOT NULL DEFAULT 1,
  external_ref     TEXT,
  error_message    TEXT,
  exported_at      TIMESTAMPTZ,
  reconciled_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version      INTEGER     NOT NULL DEFAULT 1,
  UNIQUE (org_id, provider, document_type, document_id)
);
CREATE INDEX IF NOT EXISTS idx_acct_exports_org_prov_status
  ON accounting_exports(org_id, provider, status);
CREATE INDEX IF NOT EXISTS idx_acct_exports_document
  ON accounting_exports(document_id);
CREATE INDEX IF NOT EXISTS idx_acct_exports_status
  ON accounting_exports(status, provider);

-- Line-level audit breakdown for each export (for reconciliation and dispute resolution).
CREATE TABLE IF NOT EXISTS accounting_export_lines (
  id                UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  export_id         UUID    NOT NULL REFERENCES accounting_exports(id),
  line_no           INTEGER NOT NULL,
  amount            BIGINT  NOT NULL,
  tax_component     TEXT    CHECK (tax_component IN ('cgst', 'sgst', 'igst', 'none')),
  ledger_account    TEXT    NOT NULL,
  external_line_ref TEXT,
  UNIQUE (export_id, line_no)
);
CREATE INDEX IF NOT EXISTS idx_acct_lines_export
  ON accounting_export_lines(export_id);
