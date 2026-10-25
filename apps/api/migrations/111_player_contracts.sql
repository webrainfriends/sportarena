-- Player contracts, amendments, earnings, expenses, payout runs and statements (issue #333). Additive only: new tables, indexes and trigger
-- functions. No existing table or row is modified (the settlement view of the team is extended in code, never rewritten).
-- Money model: one append-only ledger per contract (player_contract_entries), signed in the payee's favour. Offers and committed value are
-- never entries; only a verified trigger (a played game, a due date) creates an entry, and only a recorded transfer creates a payment.
-- Rollback: stop using the capabilities (revert the code). Dropping the tables is a deliberate maintainer decision, never automatic.

-- ---------------------------------------------------------------- contracts
CREATE TABLE IF NOT EXISTS player_contracts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_no     text NOT NULL UNIQUE,
  team_id         uuid REFERENCES teams,
  event_id        uuid REFERENCES events,
  payee_id        uuid NOT NULL REFERENCES users,
  response_id     uuid REFERENCES billboard_responses,        -- the accepted playing opportunity this contract came from
  legacy_payout_id uuid REFERENCES team_payouts,              -- a due fee recorded on acceptance (#67); settled through this contract
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  role            text NOT NULL DEFAULT 'player' CHECK (role IN ('player','coach','official','scorer','volunteer','staff','other')),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','offered','active','completed','terminated','void')),
  currency        text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  current_version int,                                         -- the version in force (NULL until the first version is signed)
  row_version     int NOT NULL DEFAULT 1,
  ended_on        date,
  end_reason      text CHECK (end_reason IS NULL OR length(end_reason) <= 500),
  client_key      text CHECK (client_key IS NULL OR length(client_key) BETWEEN 1 AND 64),
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (team_id IS NOT NULL OR event_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS player_contracts_response_live ON player_contracts (response_id) WHERE response_id IS NOT NULL AND status <> 'void';
CREATE UNIQUE INDEX IF NOT EXISTS player_contracts_client_key ON player_contracts (created_by, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS player_contracts_payee ON player_contracts (payee_id, status, created_at DESC, id);
CREATE INDEX IF NOT EXISTS player_contracts_team ON player_contracts (team_id, status, created_at DESC, id) WHERE team_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS player_contracts_event ON player_contracts (event_id, status, created_at DESC, id) WHERE event_id IS NOT NULL;

-- Versions: v1 is the offer, every amendment is a new version. Terms are frozen once a version leaves draft.
CREATE TABLE IF NOT EXISTS player_contract_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id     uuid NOT NULL REFERENCES player_contracts,
  version         int NOT NULL CHECK (version >= 1),
  kind            text NOT NULL CHECK (kind IN ('initial','amendment')),
  amendment_types text[] NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','proposed','in_force','superseded','declined','withdrawn','countered')),
  based_on        int,                                         -- the version in force when this one was proposed
  starts_on       date NOT NULL,
  ends_on         date NOT NULL,
  effective_from  date NOT NULL,
  currency        text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  components      jsonb NOT NULL DEFAULT '[]',
  expected_games  int NOT NULL DEFAULT 0 CHECK (expected_games BETWEEN 0 AND 500),
  withholding_bp  int NOT NULL DEFAULT 0 CHECK (withholding_bp BETWEEN 0 AND 5000),
  expense_cap_cents bigint CHECK (expense_cap_cents IS NULL OR expense_cap_cents >= 0),
  pay_terms_days  int NOT NULL DEFAULT 7 CHECK (pay_terms_days BETWEEN 0 AND 120),
  value_cents     bigint NOT NULL DEFAULT 0 CHECK (value_cents >= 0),   -- committed value: what the terms could pay, never income
  required_parties text[] NOT NULL DEFAULT '{team,player}',
  retroactive     boolean NOT NULL DEFAULT false,
  changes         jsonb NOT NULL DEFAULT '[]',                  -- field-by-field diff against `based_on`, stored at proposal time
  reason          text CHECK (reason IS NULL OR length(reason) <= 500),
  note_enc        text,                                         -- free-text covering note, field-level encrypted
  proposed_by     uuid NOT NULL REFERENCES users,
  proposed_at     timestamptz,
  decided_at      timestamptz,
  row_version     int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contract_id, version),
  CHECK (ends_on >= starts_on),
  CHECK (effective_from >= starts_on)
);
CREATE UNIQUE INDEX IF NOT EXISTS player_contract_versions_pending ON player_contract_versions (contract_id) WHERE status = 'proposed';
CREATE UNIQUE INDEX IF NOT EXISTS player_contract_versions_in_force ON player_contract_versions (contract_id) WHERE status = 'in_force';

CREATE OR REPLACE FUNCTION player_contract_versions_frozen() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' AND (
       NEW.components IS DISTINCT FROM OLD.components OR NEW.starts_on <> OLD.starts_on OR NEW.ends_on <> OLD.ends_on OR NEW.effective_from <> OLD.effective_from
       OR NEW.currency <> OLD.currency OR NEW.withholding_bp <> OLD.withholding_bp OR NEW.expense_cap_cents IS DISTINCT FROM OLD.expense_cap_cents
       OR NEW.pay_terms_days <> OLD.pay_terms_days OR NEW.expected_games <> OLD.expected_games OR NEW.value_cents <> OLD.value_cents OR NEW.version <> OLD.version) THEN
    RAISE EXCEPTION 'a contract version is frozen once it has been proposed; propose an amendment instead' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS player_contract_versions_frozen ON player_contract_versions;
CREATE TRIGGER player_contract_versions_frozen BEFORE UPDATE ON player_contract_versions FOR EACH ROW EXECUTE FUNCTION player_contract_versions_frozen();

CREATE TABLE IF NOT EXISTS player_contract_signatures (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id  uuid NOT NULL REFERENCES player_contract_versions,
  party       text NOT NULL CHECK (party IN ('player','guardian','team','finance')),
  signer_id   uuid NOT NULL REFERENCES users,
  decision    text NOT NULL CHECK (decision IN ('signed','declined')),
  comment     text CHECK (comment IS NULL OR length(comment) <= 500),
  signed_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, party)
);

-- ---------------------------------------------------------------- ledger (append-only)
CREATE TABLE IF NOT EXISTS player_contract_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq           bigserial NOT NULL,
  contract_id   uuid NOT NULL REFERENCES player_contracts,
  payee_id      uuid NOT NULL REFERENCES users,
  currency      text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  kind          text NOT NULL CHECK (kind IN ('fee','withholding','expense','payment','refund','adjustment')),
  amount_cents  bigint NOT NULL CHECK (amount_cents <> 0),    -- signed in the payee's favour: + the club owes more, - it owes less
  component_key text,
  source_key    text,
  source_type   text,
  source_id     uuid,
  version_no    int,
  occurred_on   date NOT NULL,
  label         text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  reason        text CHECK (reason IS NULL OR length(reason) <= 500),
  run_line_id   uuid,
  idem_key      text NOT NULL CHECK (length(idem_key) BETWEEN 1 AND 200),
  created_by    uuid REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contract_id, idem_key)
);
CREATE INDEX IF NOT EXISTS player_contract_entries_contract ON player_contract_entries (contract_id, seq);
CREATE INDEX IF NOT EXISTS player_contract_entries_source ON player_contract_entries (contract_id, component_key, source_key) WHERE source_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS player_contract_entries_payee ON player_contract_entries (payee_id, seq);

CREATE OR REPLACE FUNCTION player_contract_entries_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'the contract ledger is append-only; post a compensating entry' USING ERRCODE = '23514';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS player_contract_entries_append_only ON player_contract_entries;
CREATE TRIGGER player_contract_entries_append_only BEFORE UPDATE OR DELETE ON player_contract_entries FOR EACH ROW EXECUTE FUNCTION player_contract_entries_append_only();

-- ---------------------------------------------------------------- expenses
CREATE TABLE IF NOT EXISTS player_contract_expenses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id   uuid NOT NULL REFERENCES player_contracts,
  payee_id      uuid NOT NULL REFERENCES users,
  fixture_id    uuid REFERENCES fixtures,
  category      text NOT NULL CHECK (category IN ('travel','meals','kit','accommodation','other')),
  incurred_on   date NOT NULL,
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  currency      text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  over_limit    boolean NOT NULL DEFAULT false,
  note_enc      text,
  receipt_file  text,                                           -- encrypted receipt on disk (doc-store); set once, never deleted
  receipt_type  text,
  receipt_size  int,
  receipt_sha256 text,
  receipt_at    timestamptz,
  status        text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','declined','reimbursed','withdrawn')),
  decided_by    uuid REFERENCES users,
  decided_at    timestamptz,
  decision_reason text CHECK (decision_reason IS NULL OR length(decision_reason) <= 500),
  run_line_id   uuid,
  paid_at       timestamptz,
  client_key    text CHECK (client_key IS NULL OR length(client_key) BETWEEN 1 AND 64),
  row_version   int NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS player_contract_expenses_client_key ON player_contract_expenses (payee_id, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS player_contract_expenses_contract ON player_contract_expenses (contract_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS player_contract_expenses_queue ON player_contract_expenses (status, created_at, id);

-- ---------------------------------------------------------------- payout runs
CREATE TABLE IF NOT EXISTS player_payout_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_no        text NOT NULL UNIQUE,
  team_id       uuid REFERENCES teams,
  event_id      uuid REFERENCES events,
  currency      text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  as_of         date NOT NULL,                                  -- everything due up to this date is included
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','exported','closed','cancelled')),
  note          text CHECK (note IS NULL OR length(note) <= 500),
  prepared_by   uuid NOT NULL REFERENCES users,
  approved_by   uuid REFERENCES users,
  approved_at   timestamptz,
  approval_basis text CHECK (approval_basis IN ('second_person','sole_authority')),
  exported_by   uuid REFERENCES users,
  exported_at   timestamptz,
  closed_at     timestamptz,
  cancel_reason text,
  client_key    text CHECK (client_key IS NULL OR length(client_key) BETWEEN 1 AND 64),
  row_version   int NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (team_id IS NOT NULL OR event_id IS NOT NULL)
);
-- one open run per payer and currency: a person's balance can never be reserved by two runs at once
CREATE UNIQUE INDEX IF NOT EXISTS player_payout_runs_open_team ON player_payout_runs (team_id, currency) WHERE team_id IS NOT NULL AND status IN ('draft','approved','exported');
CREATE UNIQUE INDEX IF NOT EXISTS player_payout_runs_open_event ON player_payout_runs (event_id, currency) WHERE team_id IS NULL AND status IN ('draft','approved','exported');
CREATE UNIQUE INDEX IF NOT EXISTS player_payout_runs_client_key ON player_payout_runs (prepared_by, client_key) WHERE client_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS player_payout_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid NOT NULL REFERENCES player_payout_runs,
  contract_id   uuid NOT NULL REFERENCES player_contracts,
  payee_id      uuid NOT NULL REFERENCES users,
  gross_cents   bigint NOT NULL,
  withheld_cents bigint NOT NULL DEFAULT 0,
  net_cents     bigint NOT NULL CHECK (net_cents >= 0),
  status        text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','blocked','paid','failed')),
  block_code    text CHECK (block_code IN ('no_bank_account','account_unverified','consent','contract_inactive','not_signed')),
  reference     text CHECK (reference IS NULL OR length(reference) BETWEEN 3 AND 120),
  failure_code  text CHECK (failure_code IS NULL OR length(failure_code) <= 60),
  failure_reason text CHECK (failure_reason IS NULL OR length(failure_reason) <= 500),
  paid_at       timestamptz,
  recorded_by   uuid REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, contract_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS player_payout_lines_reference ON player_payout_lines (reference) WHERE reference IS NOT NULL AND status = 'paid';
CREATE INDEX IF NOT EXISTS player_payout_lines_payee ON player_payout_lines (payee_id, created_at DESC, id);

-- ---------------------------------------------------------------- statements (self-billed invoices) and credit notes
CREATE TABLE IF NOT EXISTS player_contract_counters (
  scope_key text PRIMARY KEY,
  last_no   int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS player_contract_invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        text NOT NULL,
  scope_key     text NOT NULL,
  kind          text NOT NULL DEFAULT 'statement' CHECK (kind IN ('statement','credit_note')),
  contract_id   uuid NOT NULL REFERENCES player_contracts,
  payee_id      uuid NOT NULL REFERENCES users,
  parent_id     uuid REFERENCES player_contract_invoices,
  run_line_id   uuid REFERENCES player_payout_lines,
  currency      text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  gross_cents   bigint NOT NULL,
  withheld_cents bigint NOT NULL DEFAULT 0,
  net_cents     bigint NOT NULL,
  lines         jsonb NOT NULL DEFAULT '[]',
  status        text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','paid')),
  reason        text CHECK (reason IS NULL OR length(reason) <= 500),
  issued_by     uuid REFERENCES users,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  paid_at       timestamptz,
  UNIQUE (scope_key, number)
);
CREATE INDEX IF NOT EXISTS player_contract_invoices_contract ON player_contract_invoices (contract_id, issued_at DESC, id);
CREATE INDEX IF NOT EXISTS player_contract_invoices_payee ON player_contract_invoices (payee_id, issued_at DESC, id);

CREATE TABLE IF NOT EXISTS player_contract_invoice_entries (
  invoice_id uuid NOT NULL REFERENCES player_contract_invoices,
  entry_id   uuid NOT NULL REFERENCES player_contract_entries,
  PRIMARY KEY (invoice_id, entry_id)
);
-- an entry is on at most one statement
CREATE UNIQUE INDEX IF NOT EXISTS player_contract_invoice_entries_once ON player_contract_invoice_entries (entry_id);

CREATE SEQUENCE IF NOT EXISTS player_contract_no_seq;
CREATE SEQUENCE IF NOT EXISTS player_payout_run_seq;
