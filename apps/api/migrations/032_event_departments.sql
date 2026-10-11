-- Event departments (operations, medical, media, volunteers, officials …) and their rosters.
-- Additive. Nothing is deleted: departments are archived, members "leave". Personal details on the roster are field-encrypted.

CREATE TABLE IF NOT EXISTS event_departments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES events,
  name         text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  kind         text NOT NULL DEFAULT 'custom' CHECK (kind IN ('operations','medical','media','hospitality','security','volunteers','officials','logistics','tech','ceremonies','custom')),
  description  text,
  colour       text NOT NULL DEFAULT '#7C3AED' CHECK (colour ~ '^#[0-9A-Fa-f]{6}$'),
  lead_user_id uuid REFERENCES users,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by   uuid NOT NULL REFERENCES users,
  created_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS event_departments_name ON event_departments (event_id, lower(name)) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS event_departments_event ON event_departments (event_id);

CREATE TABLE IF NOT EXISTS event_department_members (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id   uuid NOT NULL REFERENCES event_departments,
  event_id        uuid NOT NULL REFERENCES events,
  user_id         uuid NOT NULL REFERENCES users,
  role            text NOT NULL DEFAULT 'member' CHECK (role IN ('lead','member')),
  title           text CHECK (title IS NULL OR length(title) <= 60),
  status          text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','declined','left')),
  invited_by      uuid NOT NULL REFERENCES users,
  -- personal details (encrypted; every decrypted read is audit-logged)
  phone_enc       text,
  dob_enc         text,
  id_number_enc   text,
  id_number_idx   text,
  accreditation   text NOT NULL DEFAULT 'none' CHECK (accreditation IN ('none','requested','issued','revoked')),
  invited_at      timestamptz NOT NULL DEFAULT now(),
  joined_at       timestamptz,
  left_at         timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS event_department_members_open ON event_department_members (department_id, user_id) WHERE status IN ('invited','active');
CREATE INDEX IF NOT EXISTS event_department_members_user ON event_department_members (user_id, status);
CREATE INDEX IF NOT EXISTS event_department_members_event ON event_department_members (event_id, status);
