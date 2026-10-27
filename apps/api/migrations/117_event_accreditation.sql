-- Event accreditation (#481): role-based, time-limited access credentials for the people who work or play an event.
-- Additive only: new tables, no existing row changes meaning and nothing is removed.
--  * People are never copied. A credential points at the canonical user, and who may hold which category is decided live from the canonical
--    engagements (event entries and team rosters, staff assignments, fixture officials, vendors and sponsors, department rosters).
--  * The QR token is not stored: it is derived (serial + version, signed with a server key), so it carries no personal data and a reissue only
--    has to bump `credential_version` to invalidate every earlier token.
--  * Scans and history are append-only.
--  * The old per-member flag event_department_members.accreditation stays in place, kept in step by the new flow and shown as a projection.
--    Existing flags are backfilled into real accreditations at the bottom of this file so the meaning is preserved.
-- Rollback = deploy the previous code; it ignores these tables and the flag still holds the last state.

CREATE TABLE accreditation_zones (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events,
  name        text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  kind        text NOT NULL DEFAULT 'custom' CHECK (kind IN ('field_of_play','athlete_area','locker_room','officials_room','media_centre','mixed_zone','hospitality','operations','loading_service','medical','custom')),
  venue_id    uuid REFERENCES venues,
  description text CHECK (description IS NULL OR length(description) <= 300),
  archived_at timestamptz,
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX accreditation_zones_name ON accreditation_zones (event_id, lower(name)) WHERE archived_at IS NULL;
CREATE INDEX accreditation_zones_event ON accreditation_zones (event_id);

CREATE TABLE accreditation_categories (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES events,
  name             text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  -- canonical engagements that make a person eligible; 'guest' = organiser-invited VIP with no other role at the event
  eligible         text[] NOT NULL CHECK (cardinality(eligible) >= 1 AND eligible <@ ARRAY['athlete','team_staff','official','medical','volunteer','security','media','vendor','sponsor','hospitality','operations','guest']),
  colour           text NOT NULL DEFAULT '#7C3AED' CHECK (colour ~ '^#[0-9A-Fa-f]{6}$'),
  venue_id         uuid REFERENCES venues,                   -- limit the credential to one site of a multi-venue event
  valid_from       timestamptz,                              -- null = from the first event day
  valid_to         timestamptz,                              -- null = to the last event day
  daily_from       time,                                     -- optional daily time window (in `timezone`)
  daily_to         time,
  timezone         text NOT NULL DEFAULT 'UTC',
  escort_required  boolean NOT NULL DEFAULT false,
  vehicle_access   boolean NOT NULL DEFAULT false,
  equipment_access boolean NOT NULL DEFAULT false,
  requires_verification text CHECK (requires_verification IS NULL OR requires_verification IN ('gamer','coach','physio','doctor')),
  requires_photo   boolean NOT NULL DEFAULT false,
  approval         text NOT NULL DEFAULT 'organiser' CHECK (approval IN ('organiser','department_lead','auto')),
  self_apply       boolean NOT NULL DEFAULT false,
  capacity         integer CHECK (capacity IS NULL OR capacity >= 1),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by       uuid NOT NULL REFERENCES users,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from),
  CHECK ((daily_from IS NULL) = (daily_to IS NULL))
);
CREATE UNIQUE INDEX accreditation_categories_name ON accreditation_categories (event_id, lower(name)) WHERE status = 'active';
CREATE INDEX accreditation_categories_event ON accreditation_categories (event_id);

CREATE TABLE accreditation_category_zones (
  category_id uuid NOT NULL REFERENCES accreditation_categories,
  zone_id     uuid NOT NULL REFERENCES accreditation_zones,
  removed_at  timestamptz,                                   -- a zone taken out of a category is kept, not deleted
  PRIMARY KEY (category_id, zone_id)
);

CREATE TABLE accreditations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES events,
  category_id     uuid NOT NULL REFERENCES accreditation_categories,
  holder_id       uuid NOT NULL REFERENCES users,
  origin          text NOT NULL CHECK (origin IN ('self','nomination','invitation')),
  nominated_by    uuid REFERENCES users,
  team_id         uuid REFERENCES teams,                       -- set when a team manager nominated from a roster
  department_id   uuid REFERENCES event_departments,          -- set when a department lead nominated or may approve
  status          text NOT NULL DEFAULT 'submitted' CHECK (status IN ('draft','submitted','under_review','approved','rejected','withdrawn','revoked')),
  access          text NOT NULL DEFAULT 'active' CHECK (access IN ('active','suspended')),
  serial          text UNIQUE,                                 -- stable credential id, assigned at approval
  credential_version integer NOT NULL DEFAULT 0,               -- bumped on every (re)issue; the QR token embeds it
  issued_at       timestamptz,
  issued_by       uuid REFERENCES users,
  guardian_consent_at timestamptz,
  decided_by      uuid REFERENCES users,
  decided_at      timestamptz,
  reason          text CHECK (reason IS NULL OR length(reason) <= 60),   -- short code or label for reject / revoke / suspend
  note_enc        text,                                        -- free-text note, field-encrypted
  submitted_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('approved') OR serial IS NOT NULL)
);
CREATE UNIQUE INDEX accreditations_open ON accreditations (category_id, holder_id) WHERE status IN ('draft','submitted','under_review','approved');
CREATE INDEX accreditations_event ON accreditations (event_id, status);
CREATE INDEX accreditations_holder ON accreditations (holder_id, status);
CREATE INDEX accreditations_team ON accreditations (team_id) WHERE team_id IS NOT NULL;

CREATE TABLE accreditation_history (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  accreditation_id uuid NOT NULL REFERENCES accreditations,
  actor_id         uuid REFERENCES users,
  kind             text NOT NULL,
  from_status      text,
  to_status        text,
  credential_version integer,
  reason           text,
  at               timestamptz NOT NULL DEFAULT clock_timestamp()    -- not now(): steps of one transaction keep their order
);
CREATE INDEX accreditation_history_acc ON accreditation_history (accreditation_id, at);

CREATE TABLE accreditation_scans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES events,
  accreditation_id uuid REFERENCES accreditations,            -- null when the token was not recognised
  serial           text,
  zone_id          uuid REFERENCES accreditation_zones,
  operator_id      uuid NOT NULL REFERENCES users,
  direction        text NOT NULL DEFAULT 'in' CHECK (direction IN ('in','out')),
  result           text NOT NULL CHECK (result IN ('valid','invalid','expired','not_yet_valid','revoked','suspended','replaced','wrong_event','wrong_zone','outside_hours','not_eligible')),
  idempotency_key  text,
  at               timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX accreditation_scans_event ON accreditation_scans (event_id, at DESC);
CREATE INDEX accreditation_scans_acc ON accreditation_scans (accreditation_id, at DESC);
CREATE UNIQUE INDEX accreditation_scans_idem ON accreditation_scans (operator_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- history and scans are append-only (reuses the guard from the youth tables)
CREATE TRIGGER accreditation_history_append_only BEFORE UPDATE OR DELETE ON accreditation_history FOR EACH ROW EXECUTE FUNCTION youth_history_guard();
CREATE TRIGGER accreditation_scans_append_only BEFORE UPDATE OR DELETE ON accreditation_scans FOR EACH ROW EXECUTE FUNCTION youth_history_guard();

-- Backfill: every department member that already carried a badge flag becomes a real accreditation in a per-event "Department crew" category,
-- so no flag loses its meaning (requested -> submitted, issued -> approved with a credential, revoked -> revoked).
INSERT INTO accreditation_categories(event_id, name, eligible, approval, created_by)
SELECT DISTINCT m.event_id, 'Department crew', ARRAY['media','official','medical','security','volunteer','hospitality','operations'], 'organiser', e.organizer_id
  FROM event_department_members m JOIN events e ON e.id = m.event_id
 WHERE m.accreditation <> 'none';

INSERT INTO accreditations(event_id, category_id, holder_id, origin, department_id, status, serial, credential_version, issued_at, issued_by, decided_by, decided_at, reason, submitted_at)
SELECT m.event_id, k.id, m.user_id, 'nomination', m.department_id,
       CASE m.accreditation WHEN 'requested' THEN 'submitted' WHEN 'issued' THEN 'approved' ELSE 'revoked' END,
       CASE WHEN m.accreditation IN ('issued','revoked') THEN 'ACR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)) END,
       CASE WHEN m.accreditation IN ('issued','revoked') THEN 1 ELSE 0 END,
       CASE WHEN m.accreditation IN ('issued','revoked') THEN now() END,
       CASE WHEN m.accreditation IN ('issued','revoked') THEN e.organizer_id END,
       CASE WHEN m.accreditation IN ('issued','revoked') THEN e.organizer_id END,
       CASE WHEN m.accreditation IN ('issued','revoked') THEN now() END,
       CASE WHEN m.accreditation = 'revoked' THEN 'migrated' END,
       coalesce(m.joined_at, m.invited_at)
  FROM event_department_members m
  JOIN events e ON e.id = m.event_id
  JOIN accreditation_categories k ON k.event_id = m.event_id AND k.name = 'Department crew'
 WHERE m.accreditation <> 'none'
ON CONFLICT DO NOTHING;
