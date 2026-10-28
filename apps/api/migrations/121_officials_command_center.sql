-- Officials Command Center (#88). Additive only: nothing is dropped, narrowed or rewritten.
-- Reuses fixture_officials (assignment lifecycle), verification_cases (credential), fed_licences (grade), match_events / score_sheets (match day),
-- local_rule_sets (rules) and cases (disputes). New here: referee verification type, event policy, availability, briefing checklist, reports.

ALTER TABLE verification_cases DROP CONSTRAINT IF EXISTS verification_cases_type_check;
ALTER TABLE verification_cases ADD CONSTRAINT verification_cases_type_check
  CHECK (type IN ('gamer','coach','physio','doctor','sponsor','event','insurer','lawyer','recruiter','referee'));

-- Event/competition policy for who may be assigned as an official (enforced on the server at invite and accept).
ALTER TABLE events ADD COLUMN IF NOT EXISTS official_policy text NOT NULL DEFAULT 'optional' CHECK (official_policy IN ('optional','verified','licensed'));
ALTER TABLE events ADD COLUMN IF NOT EXISTS official_min_grade_rank int NOT NULL DEFAULT 0 CHECK (official_min_grade_rank BETWEEN 0 AND 20);

-- Availability: one row per weekly window or time-off block. Weekly windows are minutes-from-midnight in the official's own timezone.
CREATE TABLE IF NOT EXISTS official_availability (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  kind         text NOT NULL CHECK (kind IN ('weekly','blackout')),
  weekday      int CHECK (weekday BETWEEN 0 AND 6),
  start_minute int CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute   int CHECK (end_minute BETWEEN 1 AND 1440),
  starts_at    timestamptz,
  ends_at      timestamptz,
  note         text CHECK (note IS NULL OR length(note) <= 200),
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind='weekly' AND weekday IS NOT NULL AND start_minute IS NOT NULL AND end_minute IS NOT NULL AND end_minute > start_minute)
      OR (kind='blackout' AND starts_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at > starts_at))
);
CREATE INDEX IF NOT EXISTS official_availability_user ON official_availability(user_id, kind) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS official_prefs (
  user_id       uuid PRIMARY KEY REFERENCES users(id),
  timezone      text NOT NULL DEFAULT 'UTC',
  buffer_min    int NOT NULL DEFAULT 0 CHECK (buffer_min BETWEEN 0 AND 240),
  travel_km     int CHECK (travel_km IS NULL OR travel_km BETWEEN 1 AND 1000),
  region        text CHECK (region IS NULL OR length(region) <= 80),  -- coarse area only, never an address
  sport_ids     uuid[] NOT NULL DEFAULT '{}',
  levels        text[] NOT NULL DEFAULT '{}',
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Pre-match checklist: append-only log, the current state of an item is its latest row.
CREATE TABLE IF NOT EXISTS fixture_checklist_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id uuid NOT NULL REFERENCES fixtures(id),
  item_key   text NOT NULL CHECK (item_key ~ '^[a-z][a-z0-9_]{0,39}$'),
  done       boolean NOT NULL,
  actor_id   uuid NOT NULL REFERENCES users(id),
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fixture_checklist_fixture ON fixture_checklist_log(fixture_id, item_key, at DESC);

-- Official match / incident reports. Revisions are append-only; the note is encrypted. Operational facts only: never clinical detail.
CREATE TABLE IF NOT EXISTS official_reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id  uuid NOT NULL REFERENCES fixtures(id),
  author_id   uuid NOT NULL REFERENCES users(id),
  category    text NOT NULL CHECK (category IN ('match_report','misconduct','send_off','abandonment','venue_incident','equipment_field','protest_noted','other')),
  status      text NOT NULL DEFAULT 'filed' CHECK (status IN ('filed','revised')),
  revision    int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS official_reports_fixture ON official_reports(fixture_id, created_at);
CREATE INDEX IF NOT EXISTS official_reports_author ON official_reports(author_id, created_at DESC);

CREATE TABLE IF NOT EXISTS official_report_revisions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id       uuid NOT NULL REFERENCES official_reports(id),
  revision        int NOT NULL,
  summary         text NOT NULL CHECK (length(summary) BETWEEN 2 AND 200),
  note_enc        text,
  match_event_id  uuid REFERENCES match_events(id),
  person_id       uuid REFERENCES users(id),
  team_id         uuid REFERENCES teams(id),
  visibility      text NOT NULL DEFAULT 'organiser' CHECK (visibility IN ('author','organiser')),
  reason          text CHECK (reason IS NULL OR length(reason) <= 300),
  actor_id        uuid NOT NULL REFERENCES users(id),
  at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (report_id, revision)
);

