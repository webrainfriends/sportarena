-- Athlete Performance Integration Hub — elite extensions (#583). Additive only.
-- Adds session RPE logging so athletes can self-report perceived training load.
-- ACWR and readiness are computed on the fly from existing wearable_metrics rows.

CREATE TABLE IF NOT EXISTS session_rpe_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  logged_on date NOT NULL,
  rpe smallint NOT NULL CHECK (rpe BETWEEN 1 AND 10),
  duration_minutes int NOT NULL CHECK (duration_minutes BETWEEN 1 AND 600),
  sport text,
  notes text CHECK (char_length(notes) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX IF NOT EXISTS session_rpe_logs_user_day ON session_rpe_logs(user_id, logged_on DESC) WHERE archived_at IS NULL;
-- one entry per athlete per day per sport; allow multiple sports on the same day
CREATE UNIQUE INDEX IF NOT EXISTS session_rpe_logs_unique ON session_rpe_logs(user_id, logged_on, coalesce(sport,'')) WHERE archived_at IS NULL;
