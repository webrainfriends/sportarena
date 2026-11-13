-- Elite budget planning (#381 extension): classification (cost centre, capex, grant), period locks,
-- spend-alert thresholds, and sponsorship-budget forecasts / scenario planning. Purely additive --
-- no existing row is touched, nothing is dropped, rewritten or deleted.

ALTER TABLE sponsorship_budgets
  ADD COLUMN IF NOT EXISTS cost_centre text CHECK (cost_centre IN
    ('coaching','medical','facilities','travel','equipment','scouting','marketing','admin','it','legal','other')),
  ADD COLUMN IF NOT EXISTS capex_cents bigint CHECK (capex_cents IS NULL OR capex_cents >= 0),
  ADD COLUMN IF NOT EXISTS grant_restricted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS grant_source text CHECK (grant_source IS NULL OR char_length(grant_source) <= 200),
  ADD COLUMN IF NOT EXISTS vat_exclusive boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by uuid REFERENCES users,
  ADD COLUMN IF NOT EXISTS lock_reason text CHECK (lock_reason IS NULL OR char_length(lock_reason) <= 500),
  ADD COLUMN IF NOT EXISTS alert_at_pcts int[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS sponsorship_budget_forecasts (
  id                    uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id             uuid    NOT NULL REFERENCES sponsorship_budgets,
  name                  text    NOT NULL CHECK (char_length(name) BETWEEN 2 AND 160),
  scenario              text    NOT NULL DEFAULT 'base'
                                  CHECK (scenario IN ('best','base','worst','custom')),
  fiscal_year           int     NOT NULL,
  periods               jsonb   NOT NULL DEFAULT '[]',
  total_projected_cents bigint  NOT NULL DEFAULT 0,
  basis_actual_pct      numeric(5,2),
  spread_method         text    CHECK (spread_method IN ('even','s_curve','front','back','manual')),
  created_by            uuid    NOT NULL REFERENCES users,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  archived_at           timestamptz
);
-- Only one base/best/worst per budget×year (custom can repeat)
CREATE UNIQUE INDEX IF NOT EXISTS sbf_budget_scenario ON sponsorship_budget_forecasts
  (budget_id, fiscal_year, scenario) WHERE archived_at IS NULL AND scenario IN ('best','base','worst');
CREATE INDEX IF NOT EXISTS sbf_budget ON sponsorship_budget_forecasts
  (budget_id, fiscal_year DESC) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS sponsorship_budget_alert_events (
  id               uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id        uuid    NOT NULL REFERENCES sponsorship_budgets,
  threshold_pct    int     NOT NULL,
  utilisation_pct  numeric(5,2) NOT NULL,
  triggered_at     timestamptz NOT NULL DEFAULT now(),
  dismissed_at     timestamptz,
  dismissed_by     uuid    REFERENCES users
);
CREATE INDEX IF NOT EXISTS sbae_budget ON sponsorship_budget_alert_events
  (budget_id, triggered_at DESC) WHERE dismissed_at IS NULL;
