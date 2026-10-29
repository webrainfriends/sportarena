-- Event Operations Centre (#586): readiness requirements, incidents with escalation, operational contacts, post-event debrief and closure.
-- Additive only. Nothing here copies data owned by another domain: venue, teams, crew, accreditation, budget, sponsors, travel and media are read live.

ALTER TABLE events ADD COLUMN IF NOT EXISTS ops_closed_at timestamptz;
ALTER TABLE events ADD COLUMN IF NOT EXISTS ops_closed_by uuid REFERENCES users;

-- Explicit requirements. `derive_key` set = the status is read live from the owning domain; the organiser may only waive it (with a reason).
-- `derive_key` null = a manual requirement the organiser or its owner ticks off.
CREATE TABLE IF NOT EXISTS event_ops_requirements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL REFERENCES events,
  area          text NOT NULL CHECK (area IN ('programme','venue','participants','officials','staff','suppliers','procurement','accreditation','tickets','transport','safety','medical','media','sponsors','finance','tasks','other')),
  title         text NOT NULL CHECK (length(title) BETWEEN 3 AND 160),
  derive_key    text,
  required      boolean NOT NULL DEFAULT true,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','waived')),
  waived_reason text CHECK (waived_reason IS NULL OR length(waived_reason) BETWEEN 3 AND 300),
  owner_id      uuid REFERENCES users,
  due_on        date,
  done_by       uuid REFERENCES users,
  done_at       timestamptz,
  created_by    uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  CHECK (status <> 'waived' OR waived_reason IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS event_ops_requirements_derived ON event_ops_requirements (event_id, derive_key) WHERE derive_key IS NOT NULL AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS event_ops_requirements_event ON event_ops_requirements (event_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS event_incidents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES events,
  number           int NOT NULL,                                  -- INC-1, INC-2 … per event
  severity         text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  category         text NOT NULL CHECK (category IN ('medical','safety','security','crowd','weather','facility','conduct','technical','supplier','transport','other')),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','escalated','resolved','closed')),
  title            text NOT NULL CHECK (length(title) BETWEEN 3 AND 160),
  detail_enc       text,                                          -- may name people: field-encrypted, reads audit-logged
  resolution_enc   text,
  location         text CHECK (location IS NULL OR length(location) <= 120),
  fixture_id       uuid REFERENCES fixtures,
  department_id    uuid REFERENCES event_departments,
  reported_by      uuid NOT NULL REFERENCES users,
  assigned_to      uuid REFERENCES users,
  escalation_level int NOT NULL DEFAULT 0 CHECK (escalation_level BETWEEN 0 AND 3),
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  acknowledged_at  timestamptz,
  resolved_at      timestamptz,
  closed_at        timestamptz,
  client_key       text,                                          -- idempotency for offline retries
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, number)
);
CREATE UNIQUE INDEX IF NOT EXISTS event_incidents_client_key ON event_incidents (event_id, reported_by, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS event_incidents_event ON event_incidents (event_id, status, severity);

CREATE TABLE IF NOT EXISTS event_incident_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES event_incidents,
  actor_id    uuid REFERENCES users,
  action      text NOT NULL CHECK (action IN ('reported','acknowledged','assigned','escalated','note','resolved','reopened','closed')),
  note_enc    text,
  at          timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS event_incident_log_incident ON event_incident_log (incident_id, at);
DROP TRIGGER IF EXISTS event_incident_log_append_only ON event_incident_log;
CREATE TRIGGER event_incident_log_append_only BEFORE UPDATE OR DELETE ON event_incident_log FOR EACH ROW EXECUTE FUNCTION youth_history_guard();

CREATE TABLE IF NOT EXISTS event_ops_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events,
  area        text NOT NULL CHECK (area IN ('control_room','venue','medical','security','officials','media','transport','suppliers','sponsors','emergency','organiser','other')),
  name        text NOT NULL CHECK (length(name) BETWEEN 2 AND 100),
  role_title  text CHECK (role_title IS NULL OR length(role_title) <= 80),
  user_id     uuid REFERENCES users,                              -- when the contact is a person on the platform
  phone_enc   text,
  email_enc   text,
  on_duty     text CHECK (on_duty IS NULL OR length(on_duty) <= 120),
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX IF NOT EXISTS event_ops_contacts_event ON event_ops_contacts (event_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS event_debriefs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL UNIQUE REFERENCES events,
  summary      text CHECK (summary IS NULL OR length(summary) <= 4000),
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final')),
  finalized_by uuid REFERENCES users,
  finalized_at timestamptz,
  created_by   uuid NOT NULL REFERENCES users,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS event_debrief_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events,
  kind        text NOT NULL CHECK (kind IN ('went_well','improve','lesson')),
  area        text CHECK (area IS NULL OR area IN ('programme','venue','participants','officials','staff','suppliers','procurement','accreditation','tickets','transport','safety','medical','media','sponsors','finance','tasks','other')),
  body        text NOT NULL CHECK (length(body) BETWEEN 3 AND 1000),
  owner_id    uuid REFERENCES users,
  task_id     uuid REFERENCES event_tasks,                        -- follow-up lives in the event's task list, not here
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX IF NOT EXISTS event_debrief_items_event ON event_debrief_items (event_id) WHERE archived_at IS NULL;
