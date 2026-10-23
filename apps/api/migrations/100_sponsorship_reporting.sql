-- Sponsorship portfolio reporting (#305): saved report filters, scheduled delivery and a delivery log. Purely additive and
-- backwards-compatible. The dashboards themselves are NOT stored: they are read live from the canonical agreement, payment, award and
-- performance tables (no second ledger), so they always reconcile with the source. Nothing existing is altered, dropped or rewritten;
-- filters and schedules are archived (archived_at), never deleted; no ON DELETE CASCADE.
-- Rollback = deploy the previous code: the three tables are simply unused.

CREATE TABLE IF NOT EXISTS sponsor_report_filters (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users,
  name        text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  kind        text NOT NULL CHECK (kind IN ('ageing','funnel','outcomes','fulfilment','renewals')),
  view        text NOT NULL DEFAULT 'sponsor' CHECK (view IN ('sponsor','recipient')),
  params      jsonb NOT NULL DEFAULT '{}',          -- validated against the report parameter schema on every use
  row_version int NOT NULL DEFAULT 1,               -- optimistic lock: a stale edit gets 409
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS sponsor_report_filters_name ON sponsor_report_filters (owner_id, kind, lower(name)) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS sponsor_report_filters_owner ON sponsor_report_filters (owner_id, kind, name, id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS sponsor_report_schedules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filter_id    uuid NOT NULL REFERENCES sponsor_report_filters,
  owner_id     uuid NOT NULL REFERENCES users,
  cadence      text NOT NULL CHECK (cadence IN ('weekly','monthly','quarterly')),
  format       text NOT NULL CHECK (format IN ('csv','xlsx','pdf')),
  recipient_ids uuid[] NOT NULL CHECK (cardinality(recipient_ids) BETWEEN 1 AND 20),
  next_run_on  date NOT NULL,
  last_run_on  date,
  row_version  int NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  paused_at    timestamptz,
  archived_at  timestamptz
);
CREATE INDEX IF NOT EXISTS sponsor_report_schedules_due ON sponsor_report_schedules (next_run_on, id) WHERE archived_at IS NULL AND paused_at IS NULL;
CREATE INDEX IF NOT EXISTS sponsor_report_schedules_owner ON sponsor_report_schedules (owner_id, created_at DESC, id) WHERE archived_at IS NULL;

-- One row per (schedule, period, recipient): the unique key is what makes a repeated sweep, or two workers, deliver exactly once.
-- The report file is not stored: opening a run re-reads the data as of `as_of` under the recipient's access at that moment.
CREATE TABLE IF NOT EXISTS sponsor_report_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id  uuid NOT NULL REFERENCES sponsor_report_schedules,
  period_on    date NOT NULL,
  recipient_id uuid NOT NULL REFERENCES users,
  as_of        date NOT NULL,
  status       text NOT NULL CHECK (status IN ('delivered','skipped_no_access','failed')),
  row_count    int,
  sources      jsonb NOT NULL DEFAULT '[]',          -- missing / stale source flags as they were when this run was prepared
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, period_on, recipient_id)
);
CREATE INDEX IF NOT EXISTS sponsor_report_runs_recipient ON sponsor_report_runs (recipient_id, created_at DESC, id);
