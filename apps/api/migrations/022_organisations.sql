-- Organisation workspaces for clubs, academies and schools. Purely additive: nothing existing is altered
-- except nullable organisation_id links on teams/events/venues. Nothing is deleted; people leave (status='left'),
-- cohorts/seasons/organisations are archived. No ON DELETE CASCADE anywhere.
CREATE TABLE organisations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  kind        text NOT NULL DEFAULT 'club' CHECK (kind IN ('club','academy','school','other')),
  city        text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

-- Scoped delegation on top of existing identities. owner = full control, admin = people/structure,
-- coach = cohorts + attendance, finance = money views only (no rosters, never clinical data).
CREATE TABLE organisation_members (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  user_id         uuid NOT NULL REFERENCES users,
  role            text NOT NULL CHECK (role IN ('owner','admin','coach','finance')),
  status          text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','left','declined')),
  invited_by      uuid REFERENCES users,
  invited_at      timestamptz NOT NULL DEFAULT now(),
  joined_at       timestamptz,
  left_at         timestamptz
);
-- one live (invited or active) membership per person per organisation; history rows are kept
CREATE UNIQUE INDEX organisation_members_live ON organisation_members (organisation_id, user_id) WHERE status IN ('invited','active');
CREATE INDEX organisation_members_user ON organisation_members (user_id, status);

-- Delegation: an existing team/event/venue can belong to a workspace. Owner columns keep working unchanged.
ALTER TABLE teams  ADD COLUMN IF NOT EXISTS organisation_id uuid REFERENCES organisations;
ALTER TABLE events ADD COLUMN IF NOT EXISTS organisation_id uuid REFERENCES organisations;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS organisation_id uuid REFERENCES organisations;
CREATE INDEX IF NOT EXISTS teams_organisation  ON teams (organisation_id)  WHERE organisation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_organisation ON events (organisation_id) WHERE organisation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS venues_organisation ON venues (organisation_id) WHERE organisation_id IS NOT NULL;

CREATE TABLE org_seasons (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  name            text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  starts_on       date NOT NULL,
  ends_on         date NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on),
  UNIQUE (organisation_id, name)
);

CREATE TABLE org_cohorts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  season_id       uuid REFERENCES org_seasons,
  team_id         uuid REFERENCES teams,
  name            text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  coach_id        uuid REFERENCES users,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, name)
);
CREATE INDEX org_cohorts_org ON org_cohorts (organisation_id, status);

-- consent_at: the enrolling staff member attested the person's (or guardian's) consent; the person can withdraw.
CREATE TABLE org_enrolments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id   uuid NOT NULL REFERENCES org_cohorts,
  user_id     uuid NOT NULL REFERENCES users,
  status      text NOT NULL DEFAULT 'enrolled' CHECK (status IN ('enrolled','withdrawn')),
  consent_at  timestamptz NOT NULL,
  enrolled_by uuid NOT NULL REFERENCES users,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  UNIQUE (cohort_id, user_id)
);
CREATE INDEX org_enrolments_user ON org_enrolments (user_id);

CREATE TABLE org_attendance (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id    uuid NOT NULL REFERENCES org_cohorts,
  user_id      uuid NOT NULL REFERENCES users,
  session_date date NOT NULL,
  status       text NOT NULL CHECK (status IN ('present','absent','excused')),
  recorded_by  uuid NOT NULL REFERENCES users,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cohort_id, user_id, session_date)
);
CREATE INDEX org_attendance_cohort ON org_attendance (cohort_id, session_date);
