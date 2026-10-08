-- Doctors & physios: a person-level public provider profile (distinct from private clinical data), weekly availability and
-- time off, and consent that can be scoped, time-limited and revoked WITHOUT deleting the grant history.
-- Public discovery data (provider_profiles, provider_availability) never contains anything clinical.
CREATE TABLE provider_profiles (
  user_id        uuid PRIMARY KEY REFERENCES users,
  provider_type  text NOT NULL CHECK (provider_type IN ('physio','doctor')),
  headline       text,
  bio            text,
  clinic         text,
  city           text,
  in_person      boolean NOT NULL DEFAULT true,
  remote_ok      boolean NOT NULL DEFAULT false,
  languages      text[] NOT NULL DEFAULT '{}',
  specialties    text[] NOT NULL DEFAULT '{}',
  accepting_patients boolean NOT NULL DEFAULT true,
  currency       text,                                       -- NULL = platform payment currency
  consult_fee_cents bigint CHECK (consult_fee_cents >= 0),
  timezone       text NOT NULL DEFAULT 'UTC',
  slot_min       int NOT NULL DEFAULT 30 CHECK (slot_min BETWEEN 10 AND 240),
  listed         boolean NOT NULL DEFAULT true,              -- false hides the provider from search
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provider_profiles_search ON provider_profiles (provider_type, city) WHERE listed;

-- weekly opening windows in the provider's own time zone
CREATE TABLE provider_availability (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES users,
  weekday     int NOT NULL CHECK (weekday BETWEEN 0 AND 6),     -- 0 = Sunday
  start_min   int NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min     int NOT NULL CHECK (end_min BETWEEN 1 AND 1440),
  removed_at  timestamptz,                                     -- replaced windows are kept, not deleted
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (end_min > start_min)
);
CREATE INDEX provider_availability_provider ON provider_availability (provider_id) WHERE removed_at IS NULL;

CREATE TABLE provider_time_off (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES users,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  removed_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX provider_time_off_provider ON provider_time_off (provider_id, starts_at) WHERE removed_at IS NULL;

-- Consent: existing grants stay exactly what they were (full access, no expiry, not revoked).
ALTER TABLE medical_grants
  ADD COLUMN scope      text NOT NULL DEFAULT 'full' CHECK (scope IN ('full','clearance')),  -- clearance = fit-to-play status only
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN revoked_at timestamptz;

CREATE TABLE medical_grant_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id  uuid NOT NULL REFERENCES users,
  provider_id uuid NOT NULL REFERENCES users,
  action      text NOT NULL CHECK (action IN ('grant','revoke')),
  scope       text,
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX medical_grant_events_pair ON medical_grant_events (athlete_id, provider_id, created_at);
-- history of consent that already exists
INSERT INTO medical_grant_events(athlete_id, provider_id, action, scope, created_at) SELECT athlete_id, provider_id, 'grant', 'full', granted_at FROM medical_grants;
CREATE FUNCTION medical_grant_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'medical_grant_events is append-only'; END $$;
CREATE TRIGGER medical_grant_events_append_only BEFORE UPDATE OR DELETE ON medical_grant_events FOR EACH ROW EXECUTE FUNCTION medical_grant_events_guard();

-- appointment bookkeeping the state machine and notifications need
ALTER TABLE appointments ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN cancelled_by uuid REFERENCES users;
CREATE INDEX appointments_provider_time ON appointments (provider_id, starts_at);
