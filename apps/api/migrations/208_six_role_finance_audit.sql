-- Six-role financial source-of-truth audit (#1128)
-- Adds the reconciliation-exception queue extensions and cross-role lineage table.
-- All changes are additive; no existing data is touched.

-- Extend fin_recon_items kind check to cover six-role gap kinds
DO $$
BEGIN
  ALTER TABLE fin_recon_items DROP CONSTRAINT IF EXISTS fin_recon_items_kind_check;
  ALTER TABLE fin_recon_items ADD CONSTRAINT fin_recon_items_kind_check CHECK (kind IN (
    'payment_unrecorded','refund_drift','amount_drift','paid_without_ledger','amount_mismatch',
    'refund_unrecorded','provider_dispute','payout_failed','ledger_drift','share_mismatch',
    'physio_obligation_missing','appointment_charge_missing','six_role_gap',
    'coach_unlinked','referee_unlinked','academy_unlinked','org_unlinked',
    'sponsor_unlinked','physio_unlinked'
  ));
END $$;

-- Cross-role lineage: maps every fin_transaction back to the role-domain entity that owns it
CREATE TABLE IF NOT EXISTS fin_role_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id  uuid NOT NULL REFERENCES fin_transactions(id),
  role            text NOT NULL CHECK (role IN ('coach','referee','academy','organisation','sponsor','physio')),
  entity_id       uuid NOT NULL,       -- id in the role's own table (coach_profiles, referee_profiles, organisations…)
  entity_type     text NOT NULL,       -- e.g. 'coach_profile', 'referee_profile', 'organisation', 'sponsor_deal', 'physio_package'
  linked_at       timestamptz NOT NULL DEFAULT now(),
  meta            jsonb,
  UNIQUE (transaction_id, role, entity_id)
);
CREATE INDEX IF NOT EXISTS fin_role_links_transaction_id_idx ON fin_role_links(transaction_id);
CREATE INDEX IF NOT EXISTS fin_role_links_role_entity_idx    ON fin_role_links(role, entity_id);

-- Physio packages: the obligation source for physio-role revenue
CREATE TABLE IF NOT EXISTS physio_packages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  physio_id       uuid NOT NULL,       -- references people(id)
  name            text NOT NULL,
  currency        text NOT NULL DEFAULT 'GBP',
  price_cents     bigint NOT NULL DEFAULT 0,
  sessions        int NOT NULL DEFAULT 1,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS physio_packages_org_idx ON physio_packages(organisation_id);

-- Physio appointments: receipts source
CREATE TABLE IF NOT EXISTS physio_appointments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id      uuid REFERENCES physio_packages(id),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  physio_id       uuid NOT NULL,
  client_id       uuid NOT NULL,       -- references people(id)
  currency        text NOT NULL DEFAULT 'GBP',
  amount_cents    bigint NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','completed','cancelled','no_show')),
  scheduled_at    timestamptz NOT NULL,
  completed_at    timestamptz,
  paid_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS physio_appointments_org_idx ON physio_appointments(organisation_id);
CREATE INDEX IF NOT EXISTS physio_appointments_package_idx ON physio_appointments(package_id);

-- Six-role audit run results: one row per audit run per org
CREATE TABLE IF NOT EXISTS fin_six_role_audit_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid REFERENCES organisations(id),  -- NULL = platform-wide
  ran_at          timestamptz NOT NULL DEFAULT now(),
  gaps_total      int NOT NULL DEFAULT 0,
  gaps_open       int NOT NULL DEFAULT 0,
  gaps_resolved   int NOT NULL DEFAULT 0,
  summary         jsonb NOT NULL DEFAULT '{}',
  triggered_by    uuid REFERENCES users(id),
  source          text NOT NULL DEFAULT 'worker' CHECK (source IN ('worker','manual','api'))
);
CREATE INDEX IF NOT EXISTS fin_six_role_audit_runs_org_idx ON fin_six_role_audit_runs(organisation_id, ran_at DESC);
