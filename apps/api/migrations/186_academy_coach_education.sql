-- Academy OS P1 / #791: coach education, mentoring and TD quality assurance.
-- Additive only. Rollback = DROP the 10 new tables. No existing tables are altered.

-- CPD/education module library per org
CREATE TABLE IF NOT EXISTS academy_edu_modules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  title           text NOT NULL CHECK (length(title) BETWEEN 2 AND 160),
  kind            text NOT NULL DEFAULT 'cpd' CHECK (kind IN ('induction','cpd','credential','recertification','assessment','workshop','conference','other')),
  pillar          text CHECK (pillar IS NULL OR pillar IN ('technical','tactical','physical','mental','lifestyle')),
  mandatory       boolean NOT NULL DEFAULT false,
  cpd_hours       numeric(5,2) CHECK (cpd_hours IS NULL OR cpd_hours >= 0),
  description     text CHECK (description IS NULL OR length(description) <= 2000),
  linked_methodology_version_id uuid,  -- references academy_methodology_versions; kept loose FK to avoid migration dep
  linked_credential_kind text CHECK (linked_credential_kind IS NULL OR length(linked_credential_kind) <= 80),
  due_days_after_join int CHECK (due_days_after_join IS NULL OR due_days_after_join > 0),
  recurrence_months int CHECK (recurrence_months IS NULL OR recurrence_months BETWEEN 1 AND 60),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES users,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  row_version     int NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS academy_edu_modules_org ON academy_edu_modules (organisation_id, status);

-- Assignment of a module to a coach/cohort/role
CREATE TABLE IF NOT EXISTS academy_edu_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  module_id       uuid NOT NULL REFERENCES academy_edu_modules,
  coach_id        uuid REFERENCES users,         -- null = cohort/role assignment
  cohort_id       uuid,                          -- loose ref to org_cohorts
  role_template   text CHECK (role_template IS NULL OR length(role_template) <= 60),
  due_on          date,
  status          text NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','in_progress','submitted','approved','rejected','appealing','expired')),
  assigned_by     uuid NOT NULL REFERENCES users,
  assigned_at     timestamptz NOT NULL DEFAULT now(),
  note            text CHECK (note IS NULL OR length(note) <= 500),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  row_version     int NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS academy_edu_assignments_org ON academy_edu_assignments (organisation_id, status);
CREATE INDEX IF NOT EXISTS academy_edu_assignments_coach ON academy_edu_assignments (coach_id, status) WHERE coach_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS academy_edu_assignments_module ON academy_edu_assignments (module_id, status);

-- Evidence of completion (idempotency_key prevents duplicate submissions)
CREATE TABLE IF NOT EXISTS academy_edu_completions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id   uuid NOT NULL REFERENCES academy_edu_assignments,
  submitted_by    uuid NOT NULL REFERENCES users,
  evidence_kind   text NOT NULL CHECK (evidence_kind IN ('certificate','external_course','reflection','observation_ref','credential_ref','attendance','other')),
  evidence_ref_id uuid,         -- loose ref to a credential/compliance record or td_observation
  evidence_url    text CHECK (evidence_url IS NULL OR length(evidence_url) <= 2000),
  evidence_note   text CHECK (evidence_note IS NULL OR length(evidence_note) <= 1000),
  idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 80),
  status          text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected')),
  reviewed_by     uuid REFERENCES users,
  reviewed_at     timestamptz,
  review_note     text CHECK (review_note IS NULL OR length(review_note) <= 500),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_edu_completions_idem ON academy_edu_completions (assignment_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS academy_edu_completions_assignment ON academy_edu_completions (assignment_id, status);

-- Appeal on a rejected/failed completion
CREATE TABLE IF NOT EXISTS academy_edu_appeals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  completion_id   uuid NOT NULL REFERENCES academy_edu_completions,
  appellant_id    uuid NOT NULL REFERENCES users,
  reason          text NOT NULL CHECK (length(reason) BETWEEN 10 AND 1000),
  evidence_note   text CHECK (evidence_note IS NULL OR length(evidence_note) <= 1000),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','upheld','dismissed')),
  decided_by      uuid REFERENCES users,
  decided_at      timestamptz,
  decision_note   text CHECK (decision_note IS NULL OR length(decision_note) <= 500),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  row_version     int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_edu_appeals_one_live ON academy_edu_appeals (completion_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS academy_edu_appeals_appellant ON academy_edu_appeals (appellant_id, status);

-- Senior coach → mentee pairing; one live pairing per mentee per org
CREATE TABLE IF NOT EXISTS academy_mentor_pairings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  mentor_id       uuid NOT NULL REFERENCES users,
  mentee_id       uuid NOT NULL REFERENCES users,
  goals           jsonb NOT NULL DEFAULT '[]',  -- [{key, label, status}]
  frequency_weeks smallint NOT NULL DEFAULT 2 CHECK (frequency_weeks BETWEEN 1 AND 52),
  starts_on       date NOT NULL,
  ends_on         date,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','ended')),
  end_reason      text CHECK (end_reason IS NULL OR length(end_reason) <= 300),
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES users,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  row_version     int NOT NULL DEFAULT 1,
  CHECK (mentor_id <> mentee_id)
);
-- one live pairing per mentee per org
CREATE UNIQUE INDEX IF NOT EXISTS academy_mentor_pairings_live ON academy_mentor_pairings (organisation_id, mentee_id) WHERE status IN ('active','paused');
CREATE INDEX IF NOT EXISTS academy_mentor_pairings_mentor ON academy_mentor_pairings (mentor_id, status);
CREATE INDEX IF NOT EXISTS academy_mentor_pairings_org ON academy_mentor_pairings (organisation_id, status);

-- Mentoring session occurrences
CREATE TABLE IF NOT EXISTS academy_mentor_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pairing_id      uuid NOT NULL REFERENCES academy_mentor_pairings,
  scheduled_at    timestamptz NOT NULL,
  duration_min    smallint NOT NULL DEFAULT 60 CHECK (duration_min BETWEEN 10 AND 480),
  status          text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled','no_show')),
  agreed_actions  jsonb NOT NULL DEFAULT '[]',  -- [{label, due_on, status}]
  completed_at    timestamptz,
  cancelled_at    timestamptz,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  row_version     int NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS academy_mentor_sessions_pairing ON academy_mentor_sessions (pairing_id, scheduled_at DESC);

-- Append-only note entries per session (note_enc = encrypted)
CREATE TABLE IF NOT EXISTS academy_mentor_session_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES academy_mentor_sessions,
  author_id   uuid NOT NULL REFERENCES users,
  note_enc    text NOT NULL,   -- encrypted; never read by non-participant
  created_at  timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS academy_mentor_session_notes_guard ON academy_mentor_session_notes;
-- Append-only: no UPDATE/DELETE allowed
CREATE TRIGGER academy_mentor_session_notes_guard BEFORE UPDATE OR DELETE ON academy_mentor_session_notes FOR EACH ROW EXECUTE FUNCTION youth_history_guard();
CREATE INDEX IF NOT EXISTS academy_mentor_session_notes_session ON academy_mentor_session_notes (session_id, created_at);

-- TD quality observation (FK → academy_sessions + methodology_version_id)
CREATE TABLE IF NOT EXISTS academy_td_observations (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id          uuid NOT NULL REFERENCES organisations,
  coach_id                 uuid NOT NULL REFERENCES users,
  session_id               uuid,                     -- loose ref to academy_sessions
  methodology_version_id   uuid,                     -- loose ref to academy_methodology_versions
  rubric_id                uuid,                     -- loose ref to coach performance studio rubric
  pillar_ratings           jsonb NOT NULL DEFAULT '{}',  -- {pillar: {competency_key: rating (1-5)}}
  overall_rating           smallint CHECK (overall_rating IS NULL OR overall_rating BETWEEN 1 AND 5),
  strengths_enc            text,                     -- encrypted private notes
  development_enc          text,                     -- encrypted private notes
  next_steps               text CHECK (next_steps IS NULL OR length(next_steps) <= 2000),
  status                   text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','released')),
  released_at              timestamptz,
  released_by              uuid REFERENCES users,
  created_by               uuid NOT NULL REFERENCES users,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid REFERENCES users,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  row_version              int NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS academy_td_observations_org ON academy_td_observations (organisation_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS academy_td_observations_coach ON academy_td_observations (coach_id, organisation_id, status);

-- Improvement plan header
CREATE TABLE IF NOT EXISTS academy_coach_improvement_plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  coach_id        uuid NOT NULL REFERENCES users,
  observation_id  uuid REFERENCES academy_td_observations,
  title           text NOT NULL CHECK (length(title) BETWEEN 2 AND 200),
  focus_pillars   text[] NOT NULL DEFAULT '{}',
  summary         text CHECK (summary IS NULL OR length(summary) <= 2000),
  starts_on       date NOT NULL,
  review_on       date,
  ends_on         date,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','review','completed','withdrawn')),
  completed_at    timestamptz,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES users,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  row_version     int NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS academy_coach_improvement_plans_org ON academy_coach_improvement_plans (organisation_id, status);
CREATE INDEX IF NOT EXISTS academy_coach_improvement_plans_coach ON academy_coach_improvement_plans (coach_id, status);

-- Action items within a plan
CREATE TABLE IF NOT EXISTS academy_coach_improvement_actions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id     uuid NOT NULL REFERENCES academy_coach_improvement_plans,
  title       text NOT NULL CHECK (length(title) BETWEEN 2 AND 200),
  description text CHECK (description IS NULL OR length(description) <= 1000),
  kind        text NOT NULL DEFAULT 'cpd' CHECK (kind IN ('cpd','observation','mentoring','practice','reflection','external','other')),
  module_id   uuid REFERENCES academy_edu_modules,
  due_on      date,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','cancelled')),
  evidence    text CHECK (evidence IS NULL OR length(evidence) <= 500),
  owner_id    uuid REFERENCES users,
  done_at     timestamptz,
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version int NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS academy_coach_improvement_actions_plan ON academy_coach_improvement_actions (plan_id, status, due_on);
