-- Doctors module: country health-privacy compliance (US, UK, Canada, UAE, India, Singapore, Malaysia, China, Japan, Australia, New Zealand).
-- Additive only: new tables and nullable/defaulted columns. Nothing is converted, narrowed or deleted; the new tables refuse DELETE.

-- Which country's health-data rules a person's data is handled under, the notice they accepted and any transfer they agreed to.
CREATE TABLE IF NOT EXISTS health_privacy_profiles (
  user_id           uuid PRIMARY KEY REFERENCES users,
  regime            text NOT NULL,                       -- ISO country code from src/health/regimes.js
  notice_version    int  NOT NULL,
  notice_accepted_at timestamptz NOT NULL,
  hosting_transfer_ack_at timestamptz,                   -- agreed that data is hosted outside their country (when it is)
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Append-only history of region choices, notice acceptances and transfer acknowledgements.
CREATE TABLE IF NOT EXISTS health_privacy_events (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users,
  action     text NOT NULL CHECK (action IN ('set_region','accept_notice','transfer_ack','cross_border_ack')),
  regime     text NOT NULL,
  notice_version int,
  detail     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS health_privacy_events_user ON health_privacy_events (user_id, created_at DESC);

-- A grant records whether the patient agreed that the provider works under another country's rules.
ALTER TABLE medical_grants ADD COLUMN IF NOT EXISTS patient_regime  text;
ALTER TABLE medical_grants ADD COLUMN IF NOT EXISTS provider_regime text;
ALTER TABLE medical_grants ADD COLUMN IF NOT EXISTS cross_border_ack_at timestamptz;

-- Patient rights requests (access, correction, restriction, erasure-as-restriction, accounting, complaint…) with a due date from the country's rules.
CREATE TABLE IF NOT EXISTS health_privacy_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users,
  regime       text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('access','portability','correction','restriction','objection','erasure','accounting','withdraw_consent','complaint')),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_review','fulfilled','refused','withdrawn')),
  detail_enc   text,                                     -- what the person asked, in their words (encrypted)
  provider_id  uuid REFERENCES users,                    -- the provider it concerns, if any
  due_at       timestamptz NOT NULL,
  resolution_enc text,                                   -- the answer or the reason for a refusal (encrypted)
  resolved_by  uuid REFERENCES users,
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('fulfilled','refused') OR resolved_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS health_privacy_requests_user ON health_privacy_requests (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS health_privacy_requests_queue ON health_privacy_requests (due_at) WHERE status IN ('open','in_review');

CREATE TABLE IF NOT EXISTS health_privacy_request_events (
  id         bigserial PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES health_privacy_requests,
  actor_id   uuid NOT NULL REFERENCES users,
  from_status text,
  to_status  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Breach register for health data: what happened, who is affected, which countries' clocks are running and when each notice went out.
CREATE TABLE IF NOT EXISTS health_breaches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reported_by   uuid NOT NULL REFERENCES users,
  discovered_at timestamptz NOT NULL,
  scope         text NOT NULL CHECK (scope IN ('records','appointments','event_coverage','credentials','other')),
  event_id      uuid REFERENCES events,
  regimes       text[] NOT NULL,
  affected_count int NOT NULL CHECK (affected_count >= 0),
  severity      text NOT NULL CHECK (severity IN ('low','medium','high')),
  summary_enc   text NOT NULL,
  containment_enc text,
  status        text NOT NULL DEFAULT 'investigating' CHECK (status IN ('investigating','contained','notified','closed')),
  contained_at  timestamptz,
  closed_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS health_breaches_open ON health_breaches (discovered_at DESC);

-- One row per (country, audience) notice the breach owes. due_at is the legal clock where one is fixed; target_at is the platform's own target.
CREATE TABLE IF NOT EXISTS health_breach_notices (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  breach_id  uuid NOT NULL REFERENCES health_breaches,
  regime     text NOT NULL,
  audience   text NOT NULL CHECK (audience IN ('regulator','individuals')),
  rule       text NOT NULL,
  due_at     timestamptz,
  target_at  timestamptz NOT NULL,
  sent_at    timestamptz,
  sent_by    uuid REFERENCES users,
  reference_enc text,                                    -- regulator case number / how individuals were told (encrypted)
  not_required_at timestamptz,                           -- assessed as not notifiable, with the reason in the register
  not_required_reason_enc text,
  UNIQUE (breach_id, regime, audience)
);

CREATE OR REPLACE FUNCTION health_privacy_no_delete() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'health privacy records are never deleted' USING ERRCODE = 'check_violation'; END
$$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION health_privacy_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'health privacy history is append-only' USING ERRCODE = 'check_violation'; END
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['health_privacy_profiles','health_privacy_requests','health_breaches','health_breach_notices'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_no_delete ON %I', t, t);
    EXECUTE format('CREATE TRIGGER %I_no_delete BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION health_privacy_no_delete()', t, t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['health_privacy_events','health_privacy_request_events'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_append_only ON %I', t, t);
    EXECUTE format('CREATE TRIGGER %I_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION health_privacy_append_only()', t, t);
  END LOOP;
END $$;

-- The accounting of disclosures reads audit_log by person; index the lookup (additive, no data touched).
CREATE INDEX IF NOT EXISTS audit_log_entity_id_idx ON audit_log (entity_id, at DESC);
