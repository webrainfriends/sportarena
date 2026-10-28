-- Smart Attendance & Access (#510): trusted capture methods (rotating QR, geofence, RFID/NFC, front desk, gates) that feed the canonical
-- records (academy_attendance, team_attendance, bookings, accreditation_scans). Nothing here is a second attendance truth: a capture is
-- evidence, the canonical row is the fact. Additive only.

-- widen (never narrow) the canonical academy source list so a mark says how it was captured
ALTER TABLE academy_attendance DROP CONSTRAINT IF EXISTS academy_attendance_source_check;
ALTER TABLE academy_attendance ADD CONSTRAINT academy_attendance_source_check CHECK (source IN ('staff','bulk','qr','self','guardian','system','rfid','nfc','geo','gate','offline'));

ALTER TABLE academy_sessions ADD COLUMN IF NOT EXISTS geo_checkin boolean NOT NULL DEFAULT false;         -- self check-in must also be inside the venue geofence
ALTER TABLE academy_sessions ADD COLUMN IF NOT EXISTS geo_radius_m int NOT NULL DEFAULT 200 CHECK (geo_radius_m BETWEEN 50 AND 2000);
ALTER TABLE team_attendance ADD COLUMN IF NOT EXISTS checked_out_at timestamptz;
ALTER TABLE team_attendance ADD COLUMN IF NOT EXISTS checked_out_by uuid REFERENCES users;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS checked_in_at timestamptz;                                 -- arrival at the venue for this booking
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS checked_out_at timestamptz;

-- a door, gate, turnstile, smart lock or reader: at a venue, or at an event (optionally one accreditation zone)
CREATE TABLE IF NOT EXISTS access_points (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id       uuid REFERENCES venues,
  event_id       uuid REFERENCES events,
  zone_id        uuid REFERENCES accreditation_zones,
  name           text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  kind           text NOT NULL DEFAULT 'door' CHECK (kind IN ('door','gate','turnstile','smart_lock','locker_bank','reader')),
  provider       text NOT NULL DEFAULT 'manual',                  -- adapter key, see access-providers.js
  endpoint_url   text,                                            -- https URL of the provider/controller (webhook adapter)
  secret_enc     text,                                            -- shared secret for signing both ways, field-encrypted, shown once
  geo_checkin    boolean NOT NULL DEFAULT false,
  geo_radius_m   int NOT NULL DEFAULT 150 CHECK (geo_radius_m BETWEEN 50 AND 2000),
  early_min      int NOT NULL DEFAULT 15 CHECK (early_min BETWEEN 0 AND 240),   -- how long before a booking starts the door admits
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by     uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  archived_at    timestamptz,
  CHECK ((venue_id IS NOT NULL) <> (event_id IS NOT NULL)),
  CHECK (zone_id IS NULL OR event_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS access_points_venue ON access_points (venue_id) WHERE venue_id IS NOT NULL AND status='active';
CREATE INDEX IF NOT EXISTS access_points_event ON access_points (event_id) WHERE event_id IS NOT NULL AND status='active';

-- an RFID/NFC card, tag or wristband mapped to a person. The raw identifier is never stored (blind index only); the server decides what it opens.
CREATE TABLE IF NOT EXISTS access_credentials (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users,
  kind           text NOT NULL CHECK (kind IN ('rfid','nfc')),
  provider       text NOT NULL DEFAULT 'generic',
  credential_idx text NOT NULL,
  label          text CHECK (label IS NULL OR length(label) <= 60),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
  expires_at     timestamptz,
  registered_by  uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz,
  ended_by       uuid REFERENCES users
);
CREATE UNIQUE INDEX IF NOT EXISTS access_credentials_live ON access_credentials (provider, credential_idx) WHERE status IN ('active','suspended');
CREATE INDEX IF NOT EXISTS access_credentials_user ON access_credentials (user_id, status);

-- capture evidence: one append-only row per presentation, whatever its outcome. Never holds coordinates, a raw tag id or a raw QR token.
CREATE TABLE IF NOT EXISTS access_captures (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain           text NOT NULL CHECK (domain IN ('academy_session','team_event','venue_access','event_gate')),
  subject_ref      text NOT NULL,                                 -- session id | team_id_e_event / team_id_f_fixture | access point id
  organisation_id  uuid REFERENCES organisations,
  venue_id         uuid REFERENCES venues,
  event_id         uuid REFERENCES events,
  team_id          uuid REFERENCES teams,
  access_point_id  uuid REFERENCES access_points,
  user_id          uuid REFERENCES users,                          -- null when the credential was not recognised
  actor_id         uuid REFERENCES users,                          -- who submitted it (null for a signed device)
  actor_kind       text NOT NULL CHECK (actor_kind IN ('operator','self','guardian','device')),
  method           text NOT NULL CHECK (method IN ('qr','geo','rfid','nfc','manual','self')),
  direction        text NOT NULL DEFAULT 'in' CHECK (direction IN ('in','out')),
  verdict          text NOT NULL CHECK (verdict IN ('granted','recorded','denied','pending_review','provider_unavailable')),
  reason_code      text,
  verified         boolean NOT NULL,                               -- the server validated it live when it arrived
  offline          boolean NOT NULL DEFAULT false,                 -- captured without the server; validated only when it synced
  geo_result       text NOT NULL DEFAULT 'not_required' CHECK (geo_result IN ('not_required','inside','outside','unavailable')),
  canonical_ref    text,                                           -- e.g. academy_attendance:<id>, accreditation_scans:<id>, bookings:<id>
  reason_enc       text,                                           -- manual / review reason, field-encrypted
  flags            text[] NOT NULL DEFAULT '{}',
  device_id        text,
  token_idx        text,                                           -- hash of the first-use personal QR token (replay guard)
  idempotency_key  text,
  captured_at      timestamptz NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS access_captures_subject ON access_captures (domain, subject_ref, received_at DESC);
CREATE INDEX IF NOT EXISTS access_captures_user ON access_captures (user_id, received_at DESC);
CREATE INDEX IF NOT EXISTS access_captures_org ON access_captures (organisation_id, received_at DESC) WHERE organisation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS access_captures_venue ON access_captures (venue_id, received_at DESC) WHERE venue_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS access_captures_event ON access_captures (event_id, received_at DESC) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS access_captures_team ON access_captures (team_id, received_at DESC) WHERE team_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS access_captures_token_once ON access_captures (token_idx) WHERE token_idx IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS access_captures_idem ON access_captures (coalesce(actor_id, '00000000-0000-0000-0000-000000000000'::uuid), idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TRIGGER access_captures_append_only BEFORE UPDATE OR DELETE ON access_captures FOR EACH ROW EXECUTE FUNCTION youth_history_guard();

-- what staff decided about a capture that was held for review (a geofence miss, no location, an offline conflict)
CREATE TABLE IF NOT EXISTS access_capture_reviews (
  capture_id   uuid PRIMARY KEY REFERENCES access_captures,
  decision     text NOT NULL CHECK (decision IN ('accepted','rejected')),
  actor_id     uuid NOT NULL REFERENCES users,
  reason_enc   text NOT NULL,
  result_capture_id uuid REFERENCES access_captures,
  at           timestamptz NOT NULL DEFAULT now()
);

-- things worth a look, reported neutrally: they never block or accuse anyone by themselves
CREATE TABLE IF NOT EXISTS access_anomalies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capture_id   uuid NOT NULL REFERENCES access_captures,
  domain       text NOT NULL,
  subject_ref  text NOT NULL,
  organisation_id uuid REFERENCES organisations,
  venue_id     uuid REFERENCES venues,
  event_id     uuid REFERENCES events,
  team_id      uuid REFERENCES teams,
  user_id      uuid REFERENCES users,
  kind         text NOT NULL CHECK (kind IN ('qr_replay','rapid_repeat','concurrent_use','outside_window','geofence_mismatch','membership_inactive','booking_cancelled','accreditation_cancelled','unknown_credential','credential_inactive','provider_unavailable','offline_conflict')),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed','dismissed')),
  reviewed_by  uuid REFERENCES users,
  reviewed_at  timestamptz,
  note_enc     text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS access_anomalies_open ON access_anomalies (status, created_at DESC);
CREATE INDEX IF NOT EXISTS access_anomalies_org ON access_anomalies (organisation_id, created_at DESC) WHERE organisation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS access_anomalies_venue ON access_anomalies (venue_id, created_at DESC) WHERE venue_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS access_anomalies_event ON access_anomalies (event_id, created_at DESC) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS access_anomalies_team ON access_anomalies (team_id, created_at DESC) WHERE team_id IS NOT NULL;

-- a temporary credential issued to hardware (smart lock / gate) for something that is currently valid. It follows its source: when the booking,
-- locker assignment or accreditation stops being valid the grant is revoked, and until the provider confirms that it is shown as revoke_pending.
CREATE TABLE IF NOT EXISTS access_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  access_point_id uuid NOT NULL REFERENCES access_points,
  user_id       uuid NOT NULL REFERENCES users,
  source_type   text NOT NULL CHECK (source_type IN ('booking','locker_assignment','accreditation')),
  source_id     uuid NOT NULL,
  provider_ref  text,
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoke_pending','revoked','expired')),
  revoke_reason text,
  revoked_at    timestamptz,
  created_by    uuid REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to > valid_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS access_grants_live ON access_grants (access_point_id, source_type, source_id) WHERE status IN ('active','revoke_pending');
CREATE INDEX IF NOT EXISTS access_grants_source ON access_grants (source_type, source_id) WHERE status IN ('active','revoke_pending');
