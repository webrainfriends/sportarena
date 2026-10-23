-- Sponsorship budget controls (#293). Purely additive and backwards-compatible: a brand can authorize annual / program / department /
-- event budgets, link programs and agreements to them, and read planned / reserved / committed / paid / refunded / available balances.
-- There is NO second ledger: balances are derived live from the tables that already hold the truth (award reservations, agreement
-- obligations, confirmed and reversed payments). Existing programs, awards and agreements are untouched (budget_id stays NULL and
-- they keep working exactly as before). Nothing is dropped, rewritten or deleted; no ON DELETE CASCADE; budgets are archived, not deleted.
-- Rollback = deploy the previous code: the new tables and nullable columns are simply unused.

CREATE TABLE IF NOT EXISTS sponsorship_budgets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sponsor_id    uuid NOT NULL REFERENCES sponsors,
  parent_id     uuid REFERENCES sponsorship_budgets,          -- a carve-out of the parent's authorization (same currency)
  kind          text NOT NULL CHECK (kind IN ('annual','program','department','event')),
  name          text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  fiscal_year   int CHECK (fiscal_year BETWEEN 2000 AND 2200),
  currency      text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  authorized_cents bigint NOT NULL CHECK (authorized_cents >= 0),
  department_id uuid REFERENCES org_departments,              -- kind = department
  event_id      uuid REFERENCES events,                       -- kind = event
  approval_over_cents bigint CHECK (approval_over_cents IS NULL OR approval_over_cents >= 0), -- commitments above this need a second person's approval
  fx_policy     text NOT NULL DEFAULT 'none' CHECK (fx_policy IN ('none','explicit')),         -- none: only this currency; explicit: other currencies only at a sourced rate
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  row_version   int NOT NULL DEFAULT 1,
  created_by    uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  CHECK (kind <> 'annual' OR fiscal_year IS NOT NULL),
  CHECK (kind <> 'department' OR department_id IS NOT NULL),
  CHECK (kind <> 'event' OR event_id IS NOT NULL),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX IF NOT EXISTS sponsorship_budgets_sponsor ON sponsorship_budgets (sponsor_id, fiscal_year DESC, kind, name, id);
CREATE INDEX IF NOT EXISTS sponsorship_budgets_parent ON sponsorship_budgets (parent_id) WHERE parent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sponsorship_budgets_name ON sponsorship_budgets (sponsor_id, kind, coalesce(fiscal_year, 0), lower(name)) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS sponsorship_budgets_department ON sponsorship_budgets (sponsor_id, department_id, coalesce(fiscal_year, 0)) WHERE kind = 'department' AND status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS sponsorship_budgets_event ON sponsorship_budgets (sponsor_id, event_id) WHERE kind = 'event' AND status = 'active';

-- Sourced conversion rates. A row is never changed: a new rate supersedes the old one, and everything already committed keeps the
-- rate it was committed at (its fx_rate_id), so balances reconcile for ever.
CREATE TABLE IF NOT EXISTS sponsorship_budget_fx_rates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id   uuid NOT NULL REFERENCES sponsorship_budgets,
  currency    text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),       -- the foreign currency
  rate        numeric(20,8) NOT NULL CHECK (rate > 0),              -- budget-currency major units per 1 major unit of `currency`
  source      text NOT NULL CHECK (length(source) BETWEEN 2 AND 200),
  source_ref  text CHECK (source_ref IS NULL OR source_ref ~ '^https://'),
  as_of       date NOT NULL,
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS sponsorship_budget_fx_active ON sponsorship_budget_fx_rates (budget_id, currency) WHERE superseded_at IS NULL;

-- Append-only history of what happened to a budget.
CREATE TABLE IF NOT EXISTS sponsorship_budget_events (
  id         bigserial PRIMARY KEY,
  budget_id  uuid NOT NULL REFERENCES sponsorship_budgets,
  kind       text NOT NULL,
  actor_id   uuid REFERENCES users,
  detail     jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sponsorship_budget_events_budget ON sponsorship_budget_events (budget_id, id);

-- What draws on a budget. NULL = not budget-controlled (every existing row).
ALTER TABLE sponsorship_programs          ADD COLUMN IF NOT EXISTS budget_id uuid REFERENCES sponsorship_budgets;
ALTER TABLE sponsorship_award_reservations ADD COLUMN IF NOT EXISTS budget_id uuid REFERENCES sponsorship_budgets;
ALTER TABLE sponsorship_award_reservations ADD COLUMN IF NOT EXISTS budget_fx_rate_id uuid REFERENCES sponsorship_budget_fx_rates;
ALTER TABLE sponsorships                  ADD COLUMN IF NOT EXISTS budget_id uuid REFERENCES sponsorship_budgets;
ALTER TABLE sponsorships                  ADD COLUMN IF NOT EXISTS budget_fx_rate_id uuid REFERENCES sponsorship_budget_fx_rates;
ALTER TABLE sponsorships                  ADD COLUMN IF NOT EXISTS budget_approval text CHECK (budget_approval IN ('pending','approved','rejected'));
ALTER TABLE sponsorships                  ADD COLUMN IF NOT EXISTS budget_approval_by uuid REFERENCES users;
ALTER TABLE sponsorships                  ADD COLUMN IF NOT EXISTS budget_approval_at timestamptz;
ALTER TABLE sponsorships                  ADD COLUMN IF NOT EXISTS budget_approval_note text CHECK (budget_approval_note IS NULL OR length(budget_approval_note) <= 500);
CREATE INDEX IF NOT EXISTS sponsorship_programs_budget ON sponsorship_programs (budget_id) WHERE budget_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sponsorship_reservations_budget ON sponsorship_award_reservations (budget_id) WHERE budget_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sponsorships_budget ON sponsorships (budget_id) WHERE budget_id IS NOT NULL;
