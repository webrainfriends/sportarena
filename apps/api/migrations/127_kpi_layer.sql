-- Unified Sports Analytics & Semantic Metrics Layer (#596). Additive only.
-- The metric definitions live in code (src/kpi/catalogue.js) so a formula can never drift from the query that computes it; this migration stores
-- (1) the append-only version history of those definitions, (2) saved dashboards and (3) scheduled report deliveries. No figure is ever stored:
-- every value is computed live from the canonical tables, so the layer never holds a second copy of source-of-truth data.

CREATE TABLE IF NOT EXISTS kpi_definitions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key             text NOT NULL UNIQUE,
  current_version int  NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Immutable: a changed formula is a new version (the code refuses to publish a changed definition without a higher version number).
CREATE TABLE IF NOT EXISTS kpi_definition_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id   uuid NOT NULL REFERENCES kpi_definitions,
  version         int  NOT NULL,
  label           text NOT NULL,
  domain          text NOT NULL,
  unit            text NOT NULL,
  formula         text NOT NULL,
  dimensions      text[] NOT NULL DEFAULT '{}',
  owner           text NOT NULL,
  provenance      jsonb NOT NULL DEFAULT '[]',
  audience        text NOT NULL,
  definition_hash text NOT NULL,
  change_note     text,
  published_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (definition_id, version),
  UNIQUE (definition_id, definition_hash)
);

CREATE TABLE IF NOT EXISTS kpi_dashboards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL REFERENCES users,
  title           text NOT NULL,
  visibility      text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','organisation','roles')),
  organisation_id uuid REFERENCES organisations,
  roles           text[] NOT NULL DEFAULT '{}',
  range_preset    text NOT NULL DEFAULT 'last_30' CHECK (range_preset IN ('last_7','last_30','last_90','year_to_date','custom')),
  range_from      date,
  range_to        date,
  sport_ids       uuid[] NOT NULL DEFAULT '{}',
  widgets         jsonb NOT NULL DEFAULT '[]',
  row_version     int  NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  CHECK (visibility <> 'organisation' OR organisation_id IS NOT NULL),
  CHECK (range_preset <> 'custom' OR (range_from IS NOT NULL AND range_to IS NOT NULL AND range_to >= range_from))
);
CREATE INDEX IF NOT EXISTS kpi_dashboards_owner ON kpi_dashboards (owner_id, created_at DESC, id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS kpi_dashboards_org ON kpi_dashboards (organisation_id) WHERE archived_at IS NULL AND visibility = 'organisation';

CREATE TABLE IF NOT EXISTS kpi_report_schedules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id  uuid NOT NULL REFERENCES kpi_dashboards,
  owner_id      uuid NOT NULL REFERENCES users,
  cadence       text NOT NULL CHECK (cadence IN ('weekly','monthly','quarterly')),
  format        text NOT NULL CHECK (format IN ('csv','xlsx','pdf')),
  recipient_ids uuid[] NOT NULL CHECK (cardinality(recipient_ids) BETWEEN 1 AND 20),
  next_run_on   date NOT NULL,
  last_run_on   date,
  row_version   int  NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  paused_at     timestamptz,
  archived_at   timestamptz
);
CREATE INDEX IF NOT EXISTS kpi_report_schedules_due ON kpi_report_schedules (next_run_on, id) WHERE archived_at IS NULL AND paused_at IS NULL;
CREATE INDEX IF NOT EXISTS kpi_report_schedules_owner ON kpi_report_schedules (owner_id, created_at DESC, id) WHERE archived_at IS NULL;

-- One row per (schedule, period, recipient): the unique key makes a repeated sweep, or two workers, deliver exactly once.
-- A run holds provenance only (which definition versions it was prepared under), never figures; opening it recomputes under the recipient's live access.
CREATE TABLE IF NOT EXISTS kpi_report_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id  uuid NOT NULL REFERENCES kpi_report_schedules,
  period_on    date NOT NULL,
  recipient_id uuid NOT NULL REFERENCES users,
  status       text NOT NULL CHECK (status IN ('delivered','skipped_no_access','failed')),
  widget_count int,
  definitions  jsonb NOT NULL DEFAULT '[]',
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, period_on, recipient_id)
);
CREATE INDEX IF NOT EXISTS kpi_report_runs_recipient ON kpi_report_runs (recipient_id, created_at DESC, id);
