-- Health-data governance (US, UK, Canada, UAE, India, Singapore, Malaysia, China, Japan, Australia, New Zealand). Additive only.
-- Nothing is dropped or rewritten. The regime catalogue itself lives in code (src/health-regimes.js) and ships no rows.

-- The country whose health-privacy rules govern this person (patients) or this practice (physios and doctors). NULL = not chosen yet.
ALTER TABLE users ADD COLUMN IF NOT EXISTS health_country text CHECK (health_country IS NULL OR health_country ~ '^[A-Z]{2}$');

-- Which version of a country's notice a person read and accepted, kept so a later change can ask them again. Append-only.
CREATE TABLE IF NOT EXISTS health_notice_acceptances (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users,
  country        text NOT NULL,
  regime_version int  NOT NULL,
  accepted_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS health_notice_acceptances_user ON health_notice_acceptances (user_id, accepted_at DESC);

-- A person's rights request (access, export, correction, restriction, erasure, objection) with the deadline of their country at the time.
-- Erasure never deletes: the record is restricted and held until its retention date (see health-regimes.js); `retain_until` says when.
CREATE TABLE IF NOT EXISTS health_data_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id     uuid NOT NULL REFERENCES users,
  kind           text NOT NULL CHECK (kind IN ('access','export','correction','restriction','erasure','objection')),
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','fulfilled','declined','withdrawn')),
  country        text,
  regime_version int,
  due_at         timestamptz NOT NULL,
  detail_enc     text,                 -- what the person wrote: may describe their health, so encrypted
  response_enc   text,                 -- the answer / reason for declining
  retain_until   date,                 -- erasure/restriction: records stay until then
  decided_by     uuid REFERENCES users,
  decided_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS health_data_requests_subject ON health_data_requests (subject_id, created_at DESC);
CREATE INDEX IF NOT EXISTS health_data_requests_queue ON health_data_requests (status, due_at) WHERE status IN ('open','in_progress');

CREATE TABLE IF NOT EXISTS health_data_request_events (
  id         bigserial PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES health_data_requests,
  actor_id   uuid REFERENCES users,
  action     text NOT NULL,
  from_status text,
  to_status  text,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS health_data_request_events_request ON health_data_request_events (request_id, id);

-- Privacy / security incident register with the regulator and individual notification clocks of the affected country.
CREATE TABLE IF NOT EXISTS privacy_incidents (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reported_by            uuid NOT NULL REFERENCES users,
  country                text,
  kind                   text NOT NULL CHECK (kind IN ('unauthorised_access','loss_or_theft','misdirected_disclosure','system_compromise','improper_retention','other')),
  severity               text NOT NULL CHECK (severity IN ('low','medium','high')),
  affected_people        int  NOT NULL DEFAULT 0 CHECK (affected_people >= 0),
  health_data_involved   boolean NOT NULL DEFAULT true,
  event_id               uuid REFERENCES events,           -- set when it happened at an event the platform covers
  status                 text NOT NULL DEFAULT 'open' CHECK (status IN ('open','assessed','notified','closed')),
  occurred_at            timestamptz NOT NULL,
  aware_at               timestamptz NOT NULL DEFAULT now(),
  regime_version         int,
  regulator_due_at       timestamptz,                      -- NULL = "as soon as practicable"
  regulator_notified_at  timestamptz,
  individuals_notified_at timestamptz,
  description_enc        text NOT NULL,
  closed_at              timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS privacy_incidents_open ON privacy_incidents (status, regulator_due_at);

CREATE TABLE IF NOT EXISTS privacy_incident_events (
  id          bigserial PRIMARY KEY,
  incident_id uuid NOT NULL REFERENCES privacy_incidents,
  actor_id    uuid REFERENCES users,
  action      text NOT NULL,
  from_status text,
  to_status   text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS privacy_incident_events_incident ON privacy_incident_events (incident_id, id);

-- Histories are append-only and these records are never deleted.
CREATE OR REPLACE FUNCTION health_governance_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'check_violation'; END IF;
  IF TG_TABLE_NAME IN ('health_data_request_events','privacy_incident_events','health_notice_acceptances') THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['health_data_requests','health_data_request_events','privacy_incidents','privacy_incident_events','health_notice_acceptances'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_guard ON %I', t, t);
    EXECUTE format('CREATE TRIGGER %I_guard BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION health_governance_guard()', t, t);
  END LOOP;
END $$;
