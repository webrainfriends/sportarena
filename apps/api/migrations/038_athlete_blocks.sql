-- Personal blocks on the athlete's own calendar: recovery, gym and other time they set aside.
-- Additive. Archiving is a soft delete (status + archived_at); rows are never removed.
CREATE TABLE IF NOT EXISTS athlete_blocks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users,
  kind        text NOT NULL CHECK (kind IN ('recovery','gym','rest','other')),
  title       text,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  timezone    text NOT NULL DEFAULT 'UTC',
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS athlete_blocks_user_time ON athlete_blocks (user_id, starts_at) WHERE status = 'active';
