-- Youth accounts, verified guardian relationships, purpose-specific consent, delegated pickup/check-in (issue #70, PROD-07).
-- Additive only: new columns are nullable, new tables hold new data, nothing existing is rewritten, narrowed or removed.
-- Rollback = deploy the previous code: it ignores the new tables and columns, which can stay in place unused.
-- No destructive down-migration is provided on purpose (the project never deletes data).

-- A person is "youth" while youth_until (the date they reach the independence age of their policy) is in the future.
-- It is derived from the encrypted date of birth when that is saved and never returned by any API.
ALTER TABLE users
  ADD COLUMN youth_until      date,
  ADD COLUMN youth_checked_at timestamptz,
  ADD COLUMN jurisdiction     text NOT NULL DEFAULT 'default';
CREATE INDEX users_youth_until ON users (youth_until) WHERE youth_until IS NOT NULL;

-- Jurisdiction-configurable age rules. The platform ships one built-in 'default' policy in code; rows here override or add
-- jurisdictions. Each change is a new version; guardian links and consents record the version they were made under.
CREATE TABLE age_policies (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction         text NOT NULL,
  version              int  NOT NULL,
  independent_age      int  NOT NULL CHECK (independent_age BETWEEN 13 AND 21),
  max_guardians        int  NOT NULL DEFAULT 2 CHECK (max_guardians BETWEEN 1 AND 4),
  link_valid_days      int  NOT NULL DEFAULT 730 CHECK (link_valid_days BETWEEN 30 AND 1825),
  consent_max_days     int  NOT NULL DEFAULT 365 CHECK (consent_max_days BETWEEN 1 AND 730),
  retention_days       int  NOT NULL DEFAULT 365 CHECK (retention_days BETWEEN 30 AND 3650),
  notes                text,
  created_by           uuid REFERENCES users,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (jurisdiction, version)
);

-- Guardian <-> child relationship. Becomes 'active' only after the other party accepts AND the platform team reviews evidence.
CREATE TABLE guardian_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guardian_id    uuid NOT NULL REFERENCES users,
  child_id       uuid NOT NULL REFERENCES users,
  relationship   text NOT NULL CHECK (relationship IN ('parent','legal_guardian','foster_carer','other')),
  status         text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','accepted','pending_review','active','declined','rejected','revoked')),
  requested_by   uuid NOT NULL REFERENCES users,
  policy_jurisdiction text NOT NULL DEFAULT 'default',
  policy_version int  NOT NULL DEFAULT 1,
  co_guardian_ok_by uuid REFERENCES users,       -- an existing guardian approved this additional guardian
  co_guardian_ok_at timestamptz,
  decided_by     uuid REFERENCES users,
  decided_at     timestamptz,
  decision_note  text,
  expires_at     timestamptz,
  revoked_by     uuid REFERENCES users,
  revoked_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (guardian_id <> child_id),
  CHECK (requested_by IN (guardian_id, child_id))
);
-- one open relationship per pair at a time; history of finished ones stays
CREATE UNIQUE INDEX guardian_links_open_pair ON guardian_links (guardian_id, child_id) WHERE status IN ('invited','accepted','pending_review','active');
CREATE INDEX guardian_links_child ON guardian_links (child_id, status);
CREATE INDEX guardian_links_review ON guardian_links (created_at, id) WHERE status = 'pending_review';

CREATE TABLE guardian_evidence (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id       uuid NOT NULL REFERENCES guardian_links,
  submitted_by  uuid NOT NULL REFERENCES users,
  label         text,
  reference_enc text,
  file_name     text, content_type text, size_bytes int, sha256 text, file_enc text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX guardian_evidence_link ON guardian_evidence (link_id, created_at);

CREATE TABLE guardian_link_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id    uuid NOT NULL REFERENCES guardian_links,
  actor_id   uuid REFERENCES users,
  action     text NOT NULL,
  from_status text,
  to_status  text,
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX guardian_link_events_link ON guardian_link_events (link_id, created_at);

-- Purpose-specific consent given by a guardian for a child. One current row per purpose; changes are also appended to the event log.
CREATE TABLE youth_consents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id    uuid NOT NULL REFERENCES users,
  purpose     text NOT NULL CHECK (purpose IN ('participation','medical','media','contact')),
  granted_by  uuid NOT NULL REFERENCES users,
  policy_jurisdiction text NOT NULL DEFAULT 'default',
  policy_version int NOT NULL,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  revoked_by  uuid REFERENCES users,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (child_id, purpose)
);
CREATE TABLE youth_consent_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id   uuid NOT NULL REFERENCES users,
  purpose    text NOT NULL,
  action     text NOT NULL CHECK (action IN ('grant','revoke','expire_reset')),
  actor_id   uuid REFERENCES users,
  policy_jurisdiction text,
  policy_version int,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX youth_consent_events_child ON youth_consent_events (child_id, created_at);

-- Adults a guardian authorises to pick a child up (a platform user, a named adult, or both).
CREATE TABLE pickup_delegates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id         uuid NOT NULL REFERENCES users,
  delegate_user_id uuid REFERENCES users,
  delegate_name_enc text,
  granted_by       uuid NOT NULL REFERENCES users,
  valid_from       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  revoked_by       uuid REFERENCES users,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (delegate_user_id IS NOT NULL OR delegate_name_enc IS NOT NULL),
  CHECK (expires_at > valid_from)
);
CREATE INDEX pickup_delegates_child ON pickup_delegates (child_id, created_at);

CREATE TABLE youth_checkins (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id    uuid NOT NULL REFERENCES users,
  team_id     uuid NOT NULL REFERENCES teams,
  kind        text NOT NULL CHECK (kind IN ('drop_off','pickup')),
  actor_id    uuid NOT NULL REFERENCES users,
  released_to_user_id uuid REFERENCES users,
  delegate_id uuid REFERENCES pickup_delegates,
  note        text,
  idempotency_key text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX youth_checkins_child ON youth_checkins (child_id, at DESC, id);
CREATE UNIQUE INDEX youth_checkins_idem ON youth_checkins (actor_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- history tables are append-only
CREATE FUNCTION youth_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER guardian_link_events_append_only BEFORE UPDATE OR DELETE ON guardian_link_events FOR EACH ROW EXECUTE FUNCTION youth_history_guard();
CREATE TRIGGER youth_consent_events_append_only BEFORE UPDATE OR DELETE ON youth_consent_events FOR EACH ROW EXECUTE FUNCTION youth_history_guard();
CREATE TRIGGER youth_checkins_append_only BEFORE UPDATE OR DELETE ON youth_checkins FOR EACH ROW EXECUTE FUNCTION youth_history_guard();
