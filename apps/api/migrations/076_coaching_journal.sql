-- Coaching journal foundation (issue #269, slice 1). Additive only: new tables, no existing row is touched or removed.
-- A coaching_session_record is the execution/review layer over a canonical source (training_session, coach_hire, fixture) - it is NOT a
-- booking or calendar entry. 'team_session' covers a team/group training that has no other canonical record on main; it carries its own time.
CREATE TABLE coaching_session_records (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id      uuid NOT NULL REFERENCES users,
  sport_id      uuid REFERENCES sports,
  team_id       uuid REFERENCES teams,
  source_type   text NOT NULL CHECK (source_type IN ('training_session','coach_hire','fixture','team_session')),
  source_id     text NOT NULL,
  title         text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  objective     text CHECK (length(objective) <= 1000),
  scheduled_at  timestamptz,
  status        text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','running','completed')),
  plan_version  int  NOT NULL DEFAULT 0,
  started_plan_version int,
  block_log     jsonb NOT NULL DEFAULT '{}', -- block id -> {status, at}: execution progress, kept apart from the plan versions
  started_at    timestamptz,
  ended_at      timestamptz,
  team_summary    text CHECK (length(team_summary) <= 4000),
  private_summary text CHECK (length(private_summary) <= 4000),
  row_version   int  NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (coach_id, source_type, source_id)
);
CREATE INDEX coaching_session_records_coach ON coaching_session_records (coach_id, status, created_at DESC);
CREATE INDEX coaching_session_records_team ON coaching_session_records (team_id, created_at DESC) WHERE team_id IS NOT NULL;

-- Append-only plan versions; the version that was running when the session started stays readable forever.
CREATE TABLE coaching_session_plan_versions (
  session_record_id uuid NOT NULL REFERENCES coaching_session_records,
  version    int NOT NULL,
  blocks     jsonb NOT NULL DEFAULT '[]',
  saved_by   uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_record_id, version)
);

CREATE TABLE coaching_session_participants (
  session_record_id uuid NOT NULL REFERENCES coaching_session_records,
  athlete_id uuid NOT NULL REFERENCES users,
  attendance text NOT NULL DEFAULT 'expected' CHECK (attendance IN ('expected','present','late','left_early','absent','excused')),
  arrived_at timestamptz,
  left_at    timestamptz,
  focus      text CHECK (length(focus) <= 500),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_record_id, athlete_id)
);
CREATE INDEX coaching_session_participants_athlete ON coaching_session_participants (athlete_id);

CREATE TABLE coaching_observations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id    uuid NOT NULL REFERENCES users,
  athlete_id  uuid REFERENCES users,
  team_id     uuid REFERENCES teams,
  sport_id    uuid REFERENCES sports,
  session_record_id uuid REFERENCES coaching_session_records,
  block_ref   text,
  obs_type    text NOT NULL DEFAULT 'general' CHECK (obs_type IN ('strength','progress','development_area','tactical','technical','teamwork','behaviour','goal_evidence','follow_up','general')),
  skill_tag   text CHECK (length(skill_tag) <= 60),
  note        text NOT NULL CHECK (length(note) BETWEEN 1 AND 2000),
  visibility  text NOT NULL DEFAULT 'coach_private' CHECK (visibility IN ('coach_private','staff','player','team')),
  follow_up   boolean NOT NULL DEFAULT false,
  observed_at timestamptz NOT NULL DEFAULT now(),
  client_key  text,
  row_version int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (athlete_id IS NOT NULL OR team_id IS NOT NULL),
  CHECK (visibility <> 'player' OR athlete_id IS NOT NULL),
  CHECK (visibility <> 'team' OR (team_id IS NOT NULL AND athlete_id IS NULL)),
  CHECK (visibility <> 'staff' OR team_id IS NOT NULL)
);
CREATE UNIQUE INDEX coaching_observations_client_key ON coaching_observations (coach_id, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX coaching_observations_athlete ON coaching_observations (athlete_id, observed_at DESC, id);
CREATE INDEX coaching_observations_team ON coaching_observations (team_id, observed_at DESC, id);
CREATE INDEX coaching_observations_session ON coaching_observations (session_record_id);
CREATE INDEX coaching_observations_followup ON coaching_observations (coach_id, observed_at DESC) WHERE follow_up;

-- Edit history: the text before each edit is kept, never overwritten.
CREATE TABLE coaching_observation_revisions (
  observation_id uuid NOT NULL REFERENCES coaching_observations,
  rev        int NOT NULL,
  note       text NOT NULL,
  obs_type   text NOT NULL,
  skill_tag  text,
  visibility text NOT NULL,
  edited_by  uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (observation_id, rev)
);
