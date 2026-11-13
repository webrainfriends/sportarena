-- Federation Data Exchange Governance (#525)
-- Approved exchange profiles (inbound/outbound) with field scope, lawful purpose,
-- frequency, recipient, run log, reconciliation and four-eyes gate for personal outbound.

CREATE TABLE fed_exchange_profiles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id          uuid NOT NULL REFERENCES governing_bodies,
  direction        text NOT NULL CHECK (direction IN ('inbound','outbound')),
  name             text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  recipient_name   text NOT NULL CHECK (length(trim(recipient_name)) BETWEEN 2 AND 200),
  recipient_type   text NOT NULL CHECK (recipient_type IN ('national_body','government','anti_doping','media','research','insurance','other')),
  lawful_purpose   text NOT NULL CHECK (length(trim(lawful_purpose)) BETWEEN 10 AND 500),
  field_scope      jsonb NOT NULL DEFAULT '{}',
  includes_youth   boolean NOT NULL DEFAULT false,
  includes_health  boolean NOT NULL DEFAULT false,
  frequency        text NOT NULL CHECK (frequency IN ('on_demand','daily','weekly','monthly','annual','triggered')),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','archived')),
  approved_by      uuid NOT NULL REFERENCES users,
  approved_at      timestamptz NOT NULL DEFAULT now(),
  approval_ref     text CHECK (approval_ref IS NULL OR length(trim(approval_ref)) <= 120),
  suspended_at     timestamptz,
  suspended_reason text,
  archived_at      timestamptz,
  archived_reason  text,
  created_by       uuid NOT NULL REFERENCES users,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX fed_exchange_profiles_body ON fed_exchange_profiles (body_id, status);

-- Immutable run log for each exchange execution
CREATE TABLE fed_exchange_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id      uuid NOT NULL REFERENCES fed_exchange_profiles,
  body_id         uuid NOT NULL REFERENCES governing_bodies,
  direction       text NOT NULL CHECK (direction IN ('inbound','outbound')),
  triggered_by    uuid REFERENCES users,
  approval_id     uuid REFERENCES fed_approvals,
  status          text NOT NULL CHECK (status IN ('running','success','failed','partial')),
  row_count       integer,
  error_summary   text CHECK (error_summary IS NULL OR length(error_summary) <= 500),
  redactions      jsonb NOT NULL DEFAULT '{}',
  sha256          text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  reconciliation  jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX fed_exchange_runs_profile ON fed_exchange_runs (profile_id, started_at DESC);
CREATE INDEX fed_exchange_runs_body    ON fed_exchange_runs (body_id, started_at DESC);

-- Runs are never deleted
CREATE FUNCTION fed_exchange_runs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'exchange run logs are immutable and cannot be deleted'; END $$;
CREATE TRIGGER fed_exchange_runs_guard
  BEFORE DELETE ON fed_exchange_runs FOR EACH ROW EXECUTE FUNCTION fed_exchange_runs_guard();
