-- Competition registration & player eligibility (issue #477). Additive only: new tables, indexes and trigger functions. No existing table or row is modified.
-- A "competition season" is the existing `events` row; teams, team_members, users, sport_profiles, clinical/youth/contract data stay authoritative and are
-- only REFERENCED here. Registrations, policy versions, windows, exceptions, dependency references and match-lock snapshots are the new facts.
-- Immutable by trigger: policy versions, registration history and eligibility snapshots can never be updated or deleted, so history is never rewritten.
-- Rollback: stop using the capabilities (revert the code). Dropping the tables is a deliberate maintainer decision, never automatic.

-- ---------------------------------------------------------------- policy (versioned, append-only)
CREATE TABLE IF NOT EXISTS reg_policies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL REFERENCES events,
  version       int  NOT NULL CHECK (version >= 1),
  enforcement   text NOT NULL DEFAULT 'blocking' CHECK (enforcement IN ('advisory','blocking')),
  rules         jsonb NOT NULL,
  note          text CHECK (note IS NULL OR length(note) <= 500),
  created_by    uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, version)
);

-- ---------------------------------------------------------------- divisions / grades (birth-date categories are explicit dates, never inferred)
CREATE TABLE IF NOT EXISTS reg_divisions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES events,
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  grade            text CHECK (grade IS NULL OR length(grade) <= 40),
  born_on_or_after  date,
  born_on_or_before date,
  archived_at      timestamptz,
  created_by       uuid NOT NULL REFERENCES users,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (born_on_or_after IS NULL OR born_on_or_before IS NULL OR born_on_or_after <= born_on_or_before)
);
CREATE UNIQUE INDEX IF NOT EXISTS reg_divisions_name ON reg_divisions (event_id, lower(name)) WHERE archived_at IS NULL;

-- ---------------------------------------------------------------- registration windows (exact instants + the timezone they were authored in)
CREATE TABLE IF NOT EXISTS reg_windows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events,
  kind        text NOT NULL DEFAULT 'regular' CHECK (kind IN ('regular','late','emergency')),
  label       text CHECK (label IS NULL OR length(label) <= 80),
  opens_at    timestamptz NOT NULL,
  closes_at   timestamptz NOT NULL,
  timezone    text NOT NULL CHECK (length(timezone) BETWEEN 1 AND 64),
  retired_at  timestamptz,
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (closes_at > opens_at)
);
CREATE INDEX IF NOT EXISTS reg_windows_event ON reg_windows (event_id, opens_at) WHERE retired_at IS NULL;

-- ---------------------------------------------------------------- registrations (who is registered for which team in which competition)
CREATE TABLE IF NOT EXISTS reg_registrations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES events,
  team_id         uuid NOT NULL REFERENCES teams,
  user_id         uuid NOT NULL REFERENCES users,
  division_id     uuid REFERENCES reg_divisions,
  registration_no text CHECK (registration_no IS NULL OR length(registration_no) BETWEEN 1 AND 40),
  status          text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','under_review','registered','rejected','withdrawn','suspended','expired')),
  roster_list     text NOT NULL DEFAULT 'active' CHECK (roster_list IN ('active','reserve','development')),
  origin_class    text NOT NULL DEFAULT 'unclassified' CHECK (origin_class IN ('unclassified','local','homegrown','foreign')),   -- declared by the registrar, never inferred
  source          text NOT NULL DEFAULT 'team' CHECK (source IN ('team','self','staff')),
  window_id       uuid REFERENCES reg_windows,
  window_kind     text CHECK (window_kind IS NULL OR window_kind IN ('regular','late','emergency','exception','open')),
  exception_id    uuid,
  submitted_by    uuid NOT NULL REFERENCES users,
  effective_from  date,
  effective_to    date,
  decided_by      uuid REFERENCES users,
  decided_at      timestamptz,
  note_enc        text,                                  -- registrar's private note / reason, field-level encrypted
  row_version     int  NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)
);
-- one live registration per person per competition: the database, not the client, stops a duplicate across teams or a double submit
CREATE UNIQUE INDEX IF NOT EXISTS reg_registrations_one_live ON reg_registrations (event_id, user_id) WHERE status IN ('submitted','under_review','registered','suspended');
CREATE UNIQUE INDEX IF NOT EXISTS reg_registrations_no ON reg_registrations (event_id, lower(registration_no)) WHERE registration_no IS NOT NULL AND status NOT IN ('rejected','withdrawn');
CREATE INDEX IF NOT EXISTS reg_registrations_team ON reg_registrations (event_id, team_id, status);
CREATE INDEX IF NOT EXISTS reg_registrations_user ON reg_registrations (user_id, created_at DESC);

-- every transition keeps who / what / when and the full row as it then was
CREATE TABLE IF NOT EXISTS reg_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id uuid NOT NULL REFERENCES reg_registrations,
  row_version     int  NOT NULL,
  action          text NOT NULL CHECK (action IN ('submitted','review_started','registered','rejected','withdrawn','suspended','reinstated','expired','list_changed','corrected')),
  from_status     text,
  to_status       text,
  from_list       text,
  to_list         text,
  actor_id        uuid REFERENCES users,
  snapshot        jsonb NOT NULL,
  note_enc        text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reg_history_reg ON reg_history (registration_id, created_at, id);

-- ---------------------------------------------------------------- clearance dependencies: REFERENCES to licence / transfer / loan / disciplinary / classification records
CREATE TABLE IF NOT EXISTS reg_dependencies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES events,
  user_id      uuid NOT NULL REFERENCES users,
  kind         text NOT NULL CHECK (kind IN ('licence','transfer','loan','disciplinary','classification')),
  status       text NOT NULL CHECK (status IN ('clear','pending','blocked')),
  source_ref   text CHECK (source_ref IS NULL OR length(source_ref) <= 120),    -- the authoritative record elsewhere (federation, disciplinary panel, #323 history ...)
  source_label text CHECK (source_label IS NULL OR length(source_label) <= 120),
  valid_from   date,
  valid_until  date,
  note_enc     text,
  recorded_by  uuid NOT NULL REFERENCES users,
  superseded_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from)
);
CREATE INDEX IF NOT EXISTS reg_dependencies_live ON reg_dependencies (event_id, user_id, kind) WHERE superseded_at IS NULL;

-- ---------------------------------------------------------------- exceptions / waivers (never edit the rule or the registration; they sit beside them)
CREATE TABLE IF NOT EXISTS reg_exceptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL REFERENCES events,
  user_id       uuid NOT NULL REFERENCES users,
  rule_key      text NOT NULL CHECK (rule_key IN ('window','division_age','licence','transfer','loan','classification','disciplinary','contract','roster_limit','quota','guardian_consent')),
  reason_enc    text NOT NULL,
  evidence_enc  text,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to   timestamptz NOT NULL,
  granted_by    uuid NOT NULL REFERENCES users,
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES users,
  revoke_reason_enc text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to > effective_from)
);
CREATE INDEX IF NOT EXISTS reg_exceptions_user ON reg_exceptions (event_id, user_id, rule_key) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- eligibility snapshots: the exact policy version + decision used when a match was locked / started
CREATE TABLE IF NOT EXISTS reg_snapshots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL REFERENCES events,
  fixture_id    uuid NOT NULL REFERENCES fixtures,
  team_id       uuid NOT NULL REFERENCES teams,
  user_id       uuid NOT NULL REFERENCES users,
  stage         text NOT NULL CHECK (stage IN ('lock','start')),
  decision      text NOT NULL CHECK (decision IN ('eligible','ineligible','pending','unknown')),
  checks        jsonb NOT NULL,
  policy_id     uuid REFERENCES reg_policies,
  policy_version int,
  rules         jsonb NOT NULL,
  registration_id uuid REFERENCES reg_registrations,
  registration_version int,
  evaluated_at  timestamptz NOT NULL,
  locked_by     uuid REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fixture_id, user_id, stage)
);
CREATE INDEX IF NOT EXISTS reg_snapshots_fixture ON reg_snapshots (fixture_id, team_id);

-- ---------------------------------------------------------------- history can never be rewritten
CREATE OR REPLACE FUNCTION reg_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000'; END $$;
DROP TRIGGER IF EXISTS reg_policies_append_only ON reg_policies;
CREATE TRIGGER reg_policies_append_only BEFORE UPDATE OR DELETE ON reg_policies FOR EACH ROW EXECUTE FUNCTION reg_append_only();
DROP TRIGGER IF EXISTS reg_history_append_only ON reg_history;
CREATE TRIGGER reg_history_append_only BEFORE UPDATE OR DELETE ON reg_history FOR EACH ROW EXECUTE FUNCTION reg_append_only();
DROP TRIGGER IF EXISTS reg_snapshots_append_only ON reg_snapshots;
CREATE TRIGGER reg_snapshots_append_only BEFORE UPDATE OR DELETE ON reg_snapshots FOR EACH ROW EXECUTE FUNCTION reg_append_only();
