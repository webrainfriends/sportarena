-- Official availability and scheduling preferences (#994, REF-R03). Additive only: nothing is dropped, narrowed or rewritten, and every
-- existing weekly window, time-off block and preference row keeps its meaning. The two CHECKs on official_availability are replaced by
-- wider ones (every row that satisfied the old rule satisfies the new one).
--
-- official_availability stays the one table an official's own time lives in:
--   weekly     recurring hours they are open to officiate (minutes from local midnight), optionally for a season (valid_from..valid_to)
--   blackout   one-off time off between two instants
--   recurring  time off that repeats (weekdays, every n weeks, local minutes, between two local dates, minus excluded dates)
--   holiday    a public holiday picked from holiday_calendar_days, a whole local day
--   available  a one-off window they are explicitly open, even outside their weekly hours

ALTER TABLE official_availability DROP CONSTRAINT IF EXISTS official_availability_kind_check;
ALTER TABLE official_availability ADD CONSTRAINT official_availability_kind_check
  CHECK (kind IN ('weekly','blackout','recurring','holiday','available'));

ALTER TABLE official_availability
  ADD COLUMN IF NOT EXISTS category        text CHECK (category IS NULL OR category IN ('holiday','work','family','injury','travel','study','faith','federation_duty','other_sport','personal')),
  ADD COLUMN IF NOT EXISTS all_day         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS timezone        text,                 -- the zone local minutes and local dates are anchored in
  ADD COLUMN IF NOT EXISTS starts_on       date,                 -- local first day (recurring, holiday)
  ADD COLUMN IF NOT EXISTS ends_on         date,                 -- local last day (recurring)
  ADD COLUMN IF NOT EXISTS weekdays        int[],                -- 0 = Sunday (recurring)
  ADD COLUMN IF NOT EXISTS every_n_weeks   int NOT NULL DEFAULT 1 CHECK (every_n_weeks BETWEEN 1 AND 8),
  ADD COLUMN IF NOT EXISTS exclude_dates   date[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS valid_from      date,                 -- weekly windows: first local day they apply
  ADD COLUMN IF NOT EXISTS valid_to        date,                 -- weekly windows: last local day they apply
  ADD COLUMN IF NOT EXISTS holiday_day_id  uuid REFERENCES holiday_calendar_days(id),
  ADD COLUMN IF NOT EXISTS label           text CHECK (label IS NULL OR length(label) <= 100),
  ADD COLUMN IF NOT EXISTS note_enc        text,                 -- the official's private note, field-level encrypted; never shown to organisers
  ADD COLUMN IF NOT EXISTS version         int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at      timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 80);

ALTER TABLE official_availability DROP CONSTRAINT IF EXISTS official_availability_check;
ALTER TABLE official_availability ADD CONSTRAINT official_availability_check CHECK (
     (kind = 'weekly'    AND weekday IS NOT NULL AND start_minute IS NOT NULL AND end_minute IS NOT NULL AND end_minute > start_minute)
  OR (kind IN ('blackout','available') AND starts_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at > starts_at)
  OR (kind = 'recurring' AND weekdays IS NOT NULL AND cardinality(weekdays) BETWEEN 1 AND 7 AND start_minute IS NOT NULL AND end_minute IS NOT NULL
        AND end_minute > start_minute AND starts_on IS NOT NULL AND ends_on IS NOT NULL AND ends_on >= starts_on AND timezone IS NOT NULL)
  OR (kind = 'holiday'   AND starts_on IS NOT NULL AND timezone IS NOT NULL)
);

-- a retried request never creates a second block, and one public holiday is taken once
CREATE UNIQUE INDEX IF NOT EXISTS official_availability_idem ON official_availability(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS official_availability_holiday ON official_availability(user_id, holiday_day_id) WHERE holiday_day_id IS NOT NULL AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS official_availability_span ON official_availability(user_id, starts_at, ends_at) WHERE archived_at IS NULL AND starts_at IS NOT NULL;

-- Preferences: one row per official, now versioned so two devices cannot silently overwrite each other.
ALTER TABLE official_prefs
  ADD COLUMN IF NOT EXISTS version               int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS outside_hours_policy  text NOT NULL DEFAULT 'warn' CHECK (outside_hours_policy IN ('warn','block')),
  ADD COLUMN IF NOT EXISTS tentative_policy      text NOT NULL DEFAULT 'allow' CHECK (tentative_policy IN ('allow','one_per_slot')),
  ADD COLUMN IF NOT EXISTS buffer_same_venue_min int CHECK (buffer_same_venue_min IS NULL OR buffer_same_venue_min BETWEEN 0 AND 240),
  ADD COLUMN IF NOT EXISTS min_notice_hours      int NOT NULL DEFAULT 0 CHECK (min_notice_hours BETWEEN 0 AND 336),
  ADD COLUMN IF NOT EXISTS max_per_day           int CHECK (max_per_day IS NULL OR max_per_day BETWEEN 1 AND 12),
  ADD COLUMN IF NOT EXISTS max_per_week          int CHECK (max_per_week IS NULL OR max_per_week BETWEEN 1 AND 40),
  ADD COLUMN IF NOT EXISTS max_consecutive_days  int CHECK (max_consecutive_days IS NULL OR max_consecutive_days BETWEEN 1 AND 14),
  ADD COLUMN IF NOT EXISTS roles                 text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS age_bands             text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS country               text CHECK (country IS NULL OR length(country) BETWEEN 2 AND 60);  -- for public holidays; a country, never an address

-- Append-only record of every change an official (or an administrator acting for them) makes to availability. No notes, no reasons.
CREATE TABLE IF NOT EXISTS official_availability_history (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id),
  actor_id   uuid NOT NULL REFERENCES users(id),
  entity     text NOT NULL CHECK (entity IN ('prefs','weekly','block')),
  entity_id  uuid,
  action     text NOT NULL CHECK (action IN ('created','updated','replaced','removed')),
  before     jsonb,
  after      jsonb,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS official_availability_history_user ON official_availability_history(user_id, at DESC, id);
