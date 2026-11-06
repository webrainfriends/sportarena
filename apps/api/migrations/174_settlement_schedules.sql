-- Scheduled settlement runs (#697): automate the existing manual generate_settlement for venue contracts.
-- The manual path in partner-contracts.js still works unchanged. The worker reads settlement_schedules
-- to know which contracts to settle and when, then calls the shared generateUnsettledLines() logic.
-- Additive only. Nothing existing is altered or deleted.

CREATE TABLE settlement_schedules (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id        uuid NOT NULL UNIQUE REFERENCES partner_contracts,
  venue_id           uuid NOT NULL REFERENCES venues,
  partner_id         uuid NOT NULL REFERENCES partners,
  cycle              text NOT NULL CHECK (cycle IN ('weekly','biweekly','monthly')),
  next_run_at        date NOT NULL,
  delay_days         int  NOT NULL DEFAULT 0,            -- days after period end before generating
  auto_approve       boolean NOT NULL DEFAULT false,     -- approve without human if reconciliation is clean
  tolerance_minor    bigint  NOT NULL DEFAULT 500,       -- max paisa/cents variance before alerting
  paused             boolean NOT NULL DEFAULT false,
  paused_reason      text,
  last_run_at        date,
  last_settlement_id uuid REFERENCES settlements,
  created_by         uuid REFERENCES users,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- The worker queries by next_run_at ≤ today, skipping paused schedules.
CREATE INDEX settlement_schedules_next
  ON settlement_schedules (next_run_at)
  WHERE NOT paused;

CREATE INDEX settlement_schedules_contract
  ON settlement_schedules (contract_id);

-- ---------------------------------------------------------------- failed-payout resolution trail

CREATE TABLE settlement_failed_payout_actions (
  id             bigserial PRIMARY KEY,
  payout_item_id uuid NOT NULL REFERENCES payout_items,
  actor_id       uuid REFERENCES users,
  action         text NOT NULL CHECK (action IN (
                   'retry','request_new_account','override_account','hold','escalate','resolved')),
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sfpa_item ON settlement_failed_payout_actions (payout_item_id, id DESC);
