-- Academy OS P0 / Gap 06: Academy competition, squad & development calendar (#786). Additive only: nothing is altered, dropped or cascaded.
-- Rollback: these tables are read only by academy-competition.js. Removing them (a deliberate maintainer action, never automatic) returns the
-- academy to the state before the plan existed; teams, squads, fixtures, events, trips and appearances are untouched because the plan only
-- POINTS at them (and publishing a squad goes through the Team capability set_squad, so there is no shadow roster).

CREATE TABLE IF NOT EXISTS academy_season_plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  name            text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  starts_on       date NOT NULL,
  ends_on         date NOT NULL,
  comp_season_id  uuid REFERENCES comp_seasons,                    -- optional: the canonical competition season this plan follows
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','review','committee','published','archived')),
  notes_enc       text,
  row_version     int NOT NULL DEFAULT 1,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  CHECK (ends_on >= starts_on)
);
CREATE INDEX IF NOT EXISTS academy_season_plans_org ON academy_season_plans (organisation_id, status);

-- One row per squad-in-a-competition: a canonical team, the cohort that trains it, and the canonical event or fixture (and trip) it is for.
CREATE TABLE IF NOT EXISTS academy_plan_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id         uuid NOT NULL REFERENCES academy_season_plans,
  team_id         uuid NOT NULL REFERENCES teams,
  cohort_id       uuid REFERENCES org_cohorts,                     -- whose training sessions are checked against the match
  age_group       text CHECK (age_group IS NULL OR length(age_group) <= 20),
  event_id        uuid REFERENCES events,
  fixture_id      uuid REFERENCES fixtures,
  trip_id         uuid REFERENCES trips,                           -- #485 trip: linked by id, never copied
  squad_target    int CHECK (squad_target IS NULL OR squad_target BETWEEN 1 AND 80),
  squad_published_at timestamptz,
  squad_published_by uuid REFERENCES users,
  added_by        uuid NOT NULL REFERENCES users,
  added_at        timestamptz NOT NULL DEFAULT now(),
  removed_at      timestamptz,
  CHECK (event_id IS NOT NULL OR fixture_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_plan_entries_live ON academy_plan_entries
  (plan_id, team_id, coalesce(event_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(fixture_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS academy_plan_entries_event ON academy_plan_entries (event_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS academy_plan_entries_fixture ON academy_plan_entries (fixture_id) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS academy_plan_objectives (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id     uuid NOT NULL REFERENCES academy_season_plans,
  team_id     uuid REFERENCES teams,                               -- NULL = the whole plan
  metric      text NOT NULL CHECK (metric IN ('min_fixture_share_pct','min_minutes_per_athlete','max_consecutive_matches','min_rest_days')),
  target      numeric(8,2) NOT NULL CHECK (target >= 0),
  note_enc    text,
  set_by      uuid NOT NULL REFERENCES users,
  set_at      timestamptz NOT NULL DEFAULT now(),
  removed_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_plan_objectives_live ON academy_plan_objectives
  (plan_id, coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid), metric) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS academy_plan_checklist (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id    uuid NOT NULL REFERENCES academy_plan_entries,
  code        text NOT NULL CHECK (code IN ('medical_clearance','guardian_consent','registration','travel_booked','kit','staff_cover','exam_review')),
  state       text NOT NULL DEFAULT 'open' CHECK (state IN ('open','done','waived')),
  evidence_enc text,                                                -- who/what confirmed it, encrypted free text
  updated_by  uuid REFERENCES users,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entry_id, code)
);

-- Selection committee with approval evidence: one row per member per entry; a decision is final (a new decision supersedes via decided_at history in audit).
CREATE TABLE IF NOT EXISTS academy_plan_approvals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id    uuid NOT NULL REFERENCES academy_plan_entries,
  user_id     uuid NOT NULL REFERENCES users,
  seat        text NOT NULL CHECK (seat IN ('head_coach','performance_director','safeguarding_lead','academy_director','other')),
  decision    text NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending','approved','rejected')),
  evidence_enc text,
  decided_at  timestamptz,
  added_by    uuid NOT NULL REFERENCES users,
  removed_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_plan_approvals_live ON academy_plan_approvals (entry_id, user_id) WHERE removed_at IS NULL;
