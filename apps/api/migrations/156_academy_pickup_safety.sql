-- Academy OS P0 / Gap 08 (#788): guardian pickup, handover and daily athlete safety.
-- Additive and backwards-compatible. Nothing is dropped, rewritten or narrowed; the existing pickup_delegates / youth_checkins /
-- access_captures / academy_attendance tables stay the source of truth for who may collect, team check-ins, arrival and attendance.
-- This migration adds only what did not exist: richer collector authority, per-session handover facts, per-child departure permission,
-- an escalation policy and academy safety events. Rollback: every statement is idempotent; to roll back, deploy the previous build (the new
-- columns/tables are ignored by it) - no data has to be removed.

-- 1. Guardians may confirm / manage pickups only with the 'pickup' scope. Existing explicit scope sets keep the authority they already
--    had (pickup delegation was never scope-gated before), so we backfill rather than narrow anyone's access.
UPDATE guardian_links SET scopes = array_append(scopes, 'pickup') WHERE NOT ('pickup' = ANY(scopes));
ALTER TABLE guardian_links ALTER COLUMN scopes SET DEFAULT '{pay,register,rsvp,travel_consent,consent,calendar,pickup}';

-- 2. Richer collector authority + emergency contacts on the canonical delegate table (no parallel table).
ALTER TABLE pickup_delegates ADD COLUMN IF NOT EXISTS relationship        text;
ALTER TABLE pickup_delegates ADD COLUMN IF NOT EXISTS phone_enc           text;
ALTER TABLE pickup_delegates ADD COLUMN IF NOT EXISTS can_collect         boolean NOT NULL DEFAULT true;
ALTER TABLE pickup_delegates ADD COLUMN IF NOT EXISTS is_emergency        boolean NOT NULL DEFAULT false;
ALTER TABLE pickup_delegates ADD COLUMN IF NOT EXISTS emergency_rank      smallint;
ALTER TABLE pickup_delegates ADD COLUMN IF NOT EXISTS weekdays            smallint[];       -- ISO 1=Mon..7=Sun; null = every day
ALTER TABLE pickup_delegates ADD COLUMN IF NOT EXISTS from_time           time;             -- local time window; null = any time
ALTER TABLE pickup_delegates ADD COLUMN IF NOT EXISTS to_time             time;
ALTER TABLE pickup_delegates ADD COLUMN IF NOT EXISTS tz                  text NOT NULL DEFAULT 'UTC';
ALTER TABLE pickup_delegates ADD COLUMN IF NOT EXISTS one_time            boolean NOT NULL DEFAULT false;
ALTER TABLE pickup_delegates ADD COLUMN IF NOT EXISTS used_at             timestamptz;
ALTER TABLE pickup_delegates ADD COLUMN IF NOT EXISTS passphrase_hash     text;             -- scrypt hash, never the phrase
ALTER TABLE pickup_delegates ADD COLUMN IF NOT EXISTS organisation_id     uuid REFERENCES organisations; -- null = every academy the child attends
ALTER TABLE pickup_delegates ADD COLUMN IF NOT EXISTS id_verified_at      timestamptz;
ALTER TABLE pickup_delegates ADD COLUMN IF NOT EXISTS id_verified_by      uuid REFERENCES users;
ALTER TABLE pickup_delegates ADD COLUMN IF NOT EXISTS updated_at          timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS pickup_delegates_org ON pickup_delegates (organisation_id) WHERE organisation_id IS NOT NULL;

-- 3. A guardian's standing permission for a departure that is not "collected by an authorised adult" (walks home, takes transport).
CREATE TABLE IF NOT EXISTS pickup_departure_modes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id        uuid NOT NULL REFERENCES users,
  organisation_id uuid REFERENCES organisations,        -- null = every academy
  mode            text NOT NULL CHECK (mode IN ('walks_home','transport')),
  granted_by      uuid NOT NULL REFERENCES users,
  valid_until     timestamptz,
  revoked_at      timestamptz,
  revoked_by      uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pickup_departure_modes_child ON pickup_departure_modes (child_id, mode) WHERE revoked_at IS NULL;

-- 4. Escalation policy per organisation (versioned; a policy is retired, never deleted).
CREATE TABLE IF NOT EXISTS academy_pickup_policies (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id              uuid NOT NULL REFERENCES organisations,
  late_after_min               int NOT NULL DEFAULT 10 CHECK (late_after_min BETWEEN 1 AND 240),   -- notify guardians
  second_after_min             int NOT NULL DEFAULT 20 CHECK (second_after_min BETWEEN 1 AND 480),  -- second guardian + emergency contacts
  officer_after_min            int NOT NULL DEFAULT 40 CHECK (officer_after_min BETWEEN 1 AND 720), -- safeguarding officer
  no_show_after_min            int NOT NULL DEFAULT 15 CHECK (no_show_after_min BETWEEN 1 AND 240),
  confirm_timeout_min          int NOT NULL DEFAULT 10 CHECK (confirm_timeout_min BETWEEN 1 AND 120),
  require_guardian_confirmation boolean NOT NULL DEFAULT true,
  safeguarding_officer_id      uuid REFERENCES users,
  version                      int NOT NULL DEFAULT 1,
  created_by                   uuid NOT NULL REFERENCES users,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  retired_at                   timestamptz,
  CHECK (late_after_min <= second_after_min AND second_after_min <= officer_after_min)
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_pickup_policies_live ON academy_pickup_policies (organisation_id) WHERE retired_at IS NULL;

-- 5. One handover fact per session and athlete. Arrival stays in access_captures / academy_attendance and attendance stays in
--    academy_attendance: this row only says who took custody, how, and whether the guardian confirmed.
CREATE TABLE IF NOT EXISTS academy_handovers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id       uuid NOT NULL REFERENCES organisations,
  session_id            uuid NOT NULL REFERENCES academy_sessions,
  athlete_id            uuid NOT NULL REFERENCES users,
  state                 text NOT NULL DEFAULT 'awaiting' CHECK (state IN ('awaiting','pending_confirmation','handed_over','disputed')),
  expected_pickup_at    timestamptz NOT NULL,
  departure_mode        text CHECK (departure_mode IN ('collected','walks_home','transport')),
  collector_user_id     uuid REFERENCES users,
  delegate_id           uuid REFERENCES pickup_delegates,
  collector_kind        text CHECK (collector_kind IN ('guardian','delegate','self')),
  checks                text[] NOT NULL DEFAULT '{}',          -- qr, passphrase, id_seen, photo_match: booleans only, no images or ID numbers kept
  recorded_by           uuid REFERENCES users,
  recorded_at           timestamptz,                           -- when it happened (device time for an offline capture)
  received_at           timestamptz,                           -- when the server stored it
  offline               boolean NOT NULL DEFAULT false,
  guardian_confirmed_by uuid REFERENCES users,
  guardian_confirmed_at timestamptz,
  confirm_method        text CHECK (confirm_method IN ('guardian_app','guardian_qr','staff_override')),
  override_reason_enc   text,
  handed_over_at        timestamptz,
  escalation_level      smallint NOT NULL DEFAULT 0,           -- 0 none, 1 guardians told, 2 second guardian + emergency contacts, 3 safeguarding officer
  escalated_at          timestamptz,
  idempotency_key       text,
  row_version           int NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, athlete_id)
);
CREATE INDEX IF NOT EXISTS academy_handovers_org ON academy_handovers (organisation_id, expected_pickup_at DESC);
CREATE INDEX IF NOT EXISTS academy_handovers_open ON academy_handovers (state, expected_pickup_at) WHERE state <> 'handed_over';
CREATE UNIQUE INDEX IF NOT EXISTS academy_handovers_idem ON academy_handovers (recorded_by, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS academy_handover_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  session_id      uuid NOT NULL REFERENCES academy_sessions,
  athlete_id      uuid NOT NULL REFERENCES users,
  handover_id     uuid REFERENCES academy_handovers,
  kind            text NOT NULL,   -- recorded, guardian_confirmed, guardian_disputed, override, blocked, revoked_before, escalated, offline_conflict ...
  actor_id        uuid REFERENCES users,
  detail          text,            -- a short code or count, never personal free text
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_handover_events_session ON academy_handover_events (session_id, athlete_id, created_at);
DROP TRIGGER IF EXISTS academy_handover_events_guard ON academy_handover_events;
CREATE TRIGGER academy_handover_events_guard BEFORE UPDATE OR DELETE ON academy_handover_events FOR EACH ROW EXECUTE FUNCTION youth_history_guard();

-- 6. Safety events: exceptions, no-shows, blocked pickups, welfare concerns and incident links. Free text is encrypted; the list shows kind,
--    severity and status only. Details are for holders of the 'safeguarding' permission and every read is audit-logged.
CREATE TABLE IF NOT EXISTS academy_safety_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  session_id      uuid REFERENCES academy_sessions,
  athlete_id      uuid NOT NULL REFERENCES users,
  handover_id     uuid REFERENCES academy_handovers,
  kind            text NOT NULL CHECK (kind IN ('blocked_pickup','late_pickup','no_show','override','unconfirmed_handover','disputed_handover','offline_conflict','welfare_concern','incident')),
  severity        text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high')),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','escalated','resolved')),
  summary_enc     text,
  resolution_enc  text,
  routed_to       uuid[] NOT NULL DEFAULT '{}',
  case_id         uuid REFERENCES cases,                 -- optional link to a platform case (incident link)
  dedupe_key      text,
  opened_by       uuid REFERENCES users,                 -- null = raised by the system sweep
  opened_at       timestamptz NOT NULL DEFAULT now(),
  acknowledged_by uuid REFERENCES users,
  acknowledged_at timestamptz,
  resolved_by     uuid REFERENCES users,
  resolved_at     timestamptz,
  row_version     int NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS academy_safety_events_org ON academy_safety_events (organisation_id, status, opened_at DESC);
CREATE INDEX IF NOT EXISTS academy_safety_events_athlete ON academy_safety_events (athlete_id, opened_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS academy_safety_events_dedupe ON academy_safety_events (dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS academy_safety_event_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   uuid NOT NULL REFERENCES academy_safety_events,
  kind       text NOT NULL,   -- opened, acknowledged, escalated, note, resolved
  actor_id   uuid REFERENCES users,
  detail     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_safety_event_log_event ON academy_safety_event_log (event_id, created_at);
DROP TRIGGER IF EXISTS academy_safety_event_log_guard ON academy_safety_event_log;
CREATE TRIGGER academy_safety_event_log_guard BEFORE UPDATE OR DELETE ON academy_safety_event_log FOR EACH ROW EXECUTE FUNCTION youth_history_guard();
