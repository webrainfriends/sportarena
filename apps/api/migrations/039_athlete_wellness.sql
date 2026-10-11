-- Athlete health & recovery: daily wellness log, body-map pain log, and logged training load (for readiness and ACWR).
-- Additive. Free-text notes are encrypted (*_enc) and audit-logged when read. Nothing is deleted: loads archive, pain resolves.
CREATE TABLE IF NOT EXISTS wellness_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users,
  log_date      date NOT NULL,
  sleep_hours   numeric(4,2) CHECK (sleep_hours BETWEEN 0 AND 24),
  sleep_quality smallint CHECK (sleep_quality BETWEEN 1 AND 5),
  soreness      smallint CHECK (soreness BETWEEN 0 AND 10),
  mood          smallint CHECK (mood BETWEEN 1 AND 5),
  water_ml      integer CHECK (water_ml BETWEEN 0 AND 20000),
  note_enc      text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, log_date)
);

CREATE TABLE IF NOT EXISTS body_pain_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users,
  region      text NOT NULL,
  side        text NOT NULL DEFAULT 'centre' CHECK (side IN ('left','right','centre')),
  kind        text NOT NULL DEFAULT 'pain' CHECK (kind IN ('pain','tightness','fatigue')),
  severity    smallint NOT NULL CHECK (severity BETWEEN 1 AND 10),
  started_on  date NOT NULL DEFAULT current_date,
  resolved_at timestamptz,
  note_enc    text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS body_pain_user_open ON body_pain_logs (user_id, created_at DESC) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS session_loads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users,
  session_date date NOT NULL,
  kind         text NOT NULL DEFAULT 'training' CHECK (kind IN ('training','match','gym','other')),
  minutes      integer NOT NULL CHECK (minutes BETWEEN 1 AND 600),
  rpe          smallint NOT NULL CHECK (rpe BETWEEN 1 AND 10),
  load         integer GENERATED ALWAYS AS (minutes * rpe) STORED,
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS session_loads_user_date ON session_loads (user_id, session_date) WHERE archived_at IS NULL;
