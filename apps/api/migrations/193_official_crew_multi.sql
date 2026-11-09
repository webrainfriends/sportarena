-- Multi-official crew setup and substitution (#996).
-- Additive only: extends roles/status check constraints, adds crew requirement and substitution tables.

-- Extend official roles: 7 new roles on top of the 4 from migration 024.
ALTER TABLE fixture_officials DROP CONSTRAINT IF EXISTS fixture_officials_role_check;
ALTER TABLE fixture_officials ADD CONSTRAINT fixture_officials_role_check
  CHECK (role IN (
    'referee','umpire','linesman','scorer',
    'video_assistant_referee','fourth_official','reserve_assistant_referee',
    'shot_clock_operator','timekeeper','goal_line_official','technical_official'
  ));

-- Extend assignment status: add 'substituted' terminal state (official replaced mid-match).
ALTER TABLE fixture_officials DROP CONSTRAINT IF EXISTS fixture_officials_status_check;
ALTER TABLE fixture_officials ADD CONSTRAINT fixture_officials_status_check
  CHECK (status IN ('invited','accepted','declined','withdrawn','released','cancelled','completed','substituted'));

-- FK back to the assignment that this one replaced (emergency substitution chain).
ALTER TABLE fixture_officials ADD COLUMN IF NOT EXISTS substitution_of uuid REFERENCES fixture_officials(id);
-- Flag: organiser accepted on the official's behalf (emergency mid-match, official confirms post-match).
ALTER TABLE fixture_officials ADD COLUMN IF NOT EXISTS emergency_accept boolean NOT NULL DEFAULT false;
-- Broadcast message to the whole crew for this fixture (append-only channel).
ALTER TABLE fixture_officials ADD COLUMN IF NOT EXISTS crew_note text CHECK (crew_note IS NULL OR length(crew_note) <= 500);

-- Per-event crew requirement: how many of each role a fixture needs to be "crew complete".
CREATE TABLE IF NOT EXISTS event_crew_requirements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events(id),
  role        text NOT NULL CHECK (role IN (
                'referee','umpire','linesman','scorer',
                'video_assistant_referee','fourth_official','reserve_assistant_referee',
                'shot_clock_operator','timekeeper','goal_line_official','technical_official'
              )),
  min_count   int NOT NULL DEFAULT 1 CHECK (min_count BETWEEN 0 AND 20),
  max_count   int NOT NULL DEFAULT 1 CHECK (max_count BETWEEN 1 AND 20),
  mandatory   boolean NOT NULL DEFAULT true,
  notes       text CHECK (notes IS NULL OR length(notes) <= 300),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, role),
  CHECK (max_count >= min_count)
);
CREATE INDEX IF NOT EXISTS event_crew_req_event ON event_crew_requirements(event_id);

-- Per-official slot duties (what this specific person does beyond their role label).
ALTER TABLE fixture_officials ADD COLUMN IF NOT EXISTS duties text[] NOT NULL DEFAULT '{}';

-- Crew broadcast channel: messages visible to the full accepted crew of a fixture.
CREATE TABLE IF NOT EXISTS crew_broadcast_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id  uuid NOT NULL REFERENCES fixtures(id),
  author_id   uuid NOT NULL REFERENCES users(id),
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  pinned      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crew_broadcast_fixture ON crew_broadcast_messages(fixture_id, created_at DESC);

-- Crew completeness snapshot: cached per fixture, refreshed on every assignment change.
CREATE TABLE IF NOT EXISTS fixture_crew_completeness (
  fixture_id    uuid PRIMARY KEY REFERENCES fixtures(id),
  is_complete   boolean NOT NULL DEFAULT false,
  missing_roles text[] NOT NULL DEFAULT '{}',
  total_slots   int NOT NULL DEFAULT 0,
  filled_slots  int NOT NULL DEFAULT 0,
  checked_at    timestamptz NOT NULL DEFAULT now()
);
