-- Finance control plane, organisation edition (#593). Additive only: extends the canonical ledger of #564 with the dimensions an organisation
-- filters by, a due date for ageing, and permissioned finance access. Nothing is dropped, rewritten or narrowed; the ledger stays append-only
-- (the fin_transactions_guard trigger still refuses any change to kind, amounts, currency, source type, idem key, payment or parties).

ALTER TABLE fin_transactions ADD COLUMN IF NOT EXISTS season_id    uuid REFERENCES org_seasons;
ALTER TABLE fin_transactions ADD COLUMN IF NOT EXISTS event_id     uuid REFERENCES events;
ALTER TABLE fin_transactions ADD COLUMN IF NOT EXISTS team_id      uuid REFERENCES teams;
ALTER TABLE fin_transactions ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES org_departments;   -- the organisation workspace (department) the money belongs to
ALTER TABLE fin_transactions ADD COLUMN IF NOT EXISTS due_on       date;                              -- when a charge falls due (ageing, upcoming cash)
ALTER TABLE fin_transactions ADD COLUMN IF NOT EXISTS category     text;                              -- canonical view: registration, tickets, venue_service, sponsorship, suppliers, event_budget, commissions, other

CREATE INDEX IF NOT EXISTS fin_tx_open_due ON fin_transactions (due_on) WHERE kind = 'charge' AND status = 'open';
CREATE INDEX IF NOT EXISTS fin_tx_category ON fin_transactions (category, occurred_at DESC);
CREATE INDEX IF NOT EXISTS fin_tx_event ON fin_transactions (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fin_tx_team ON fin_transactions (team_id) WHERE team_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fin_tx_season ON fin_transactions (season_id) WHERE season_id IS NOT NULL;

-- Permissioned finance access on top of the organisation role. Owner / admin / finance keep their access exactly as before; a grant adds a
-- finer level for anyone else (for example an external accountant or a treasurer who is not a member with the finance role):
--   viewer      read the books
--   accountant  read, export, and close reconciliation items of the organisation
--   controller  everything an accountant can, and grant or revoke finance access
-- Revoking sets status, it never deletes the row (history is kept) and takes effect on the next call.
CREATE TABLE IF NOT EXISTS fin_finance_access (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  user_id         uuid NOT NULL REFERENCES users,
  level           text NOT NULL CHECK (level IN ('viewer','accountant','controller')),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  granted_by      uuid REFERENCES users,
  revoked_by      uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_access_active ON fin_finance_access (organisation_id, user_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS fin_access_user ON fin_finance_access (user_id) WHERE status = 'active';

-- which organisation a reconciliation item belongs to, so organisation controllers can close their own (platform admin still closes any)
ALTER TABLE fin_recon_items ADD COLUMN IF NOT EXISTS organisation_id uuid REFERENCES organisations;
