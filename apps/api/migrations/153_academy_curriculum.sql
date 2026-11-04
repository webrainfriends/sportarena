-- Academy OS P0 / #782: coaching philosophy, curriculum & methodology governance.
-- Additive only (new tables, nothing altered or dropped). Rollback = stop using the capabilities; the tables hold governance records and are never deleted
-- (see docs/academy-curriculum.md). There is no training-plan, session or scoring engine here: objectives are *referenced* from the canonical
-- academy_sessions and the coach's coaching session record (plan blocks + block_log), and competencies may point at an existing coaching rubric.

-- 1. Methodology library: one per academy + sport. Versions are append-only.
CREATE TABLE IF NOT EXISTS academy_methodologies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  sport           text NOT NULL CHECK (length(sport) BETWEEN 2 AND 40),
  title           text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  current_version int  NOT NULL DEFAULT 0,
  row_version     int  NOT NULL DEFAULT 1,
  created_by      uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, sport, title)
);
CREATE INDEX IF NOT EXISTS academy_methodologies_org ON academy_methodologies (organisation_id, status);

CREATE TABLE IF NOT EXISTS academy_methodology_versions (
  methodology_id uuid NOT NULL REFERENCES academy_methodologies,
  version        int  NOT NULL,
  philosophy     jsonb NOT NULL DEFAULT '{}',   -- {statement, values:[{key,title,description}]}
  competencies   jsonb NOT NULL DEFAULT '[]',   -- [{key,pillar,title,description,rubric_id?,dimension_key?}] technical/tactical/physical/mental/lifestyle
  outcomes       jsonb NOT NULL DEFAULT '[]',   -- [{competency_key,age_min?,age_max?,level_key?,position?,outcome}]
  drills         jsonb NOT NULL DEFAULT '[]',   -- approved drill templates [{key,title,kind,competency_keys,duration_min,...}]
  stages         jsonb NOT NULL DEFAULT '[]',   -- the age/level ladder [{key,title,age_min,age_max,hours_per_week,focus}]
  game_model     jsonb NOT NULL DEFAULT '[]',   -- principles of play by phase [{key,phase,title,description}]
  standards      jsonb NOT NULL DEFAULT '{}',   -- session design standards {session_minutes,rpe_target,max_group_size,coach_ratio,notes}
  effective_from date NOT NULL DEFAULT current_date,
  note           text CHECK (note IS NULL OR length(note) <= 300),
  created_by     uuid REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (methodology_id, version)
);

-- 2. Curricula: scoped by season, age band, level, campus (an academy venue) with controlled inheritance from a parent curriculum.
CREATE TABLE IF NOT EXISTS academy_curricula (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  methodology_id  uuid NOT NULL REFERENCES academy_methodologies,
  parent_id       uuid REFERENCES academy_curricula,
  season_id       uuid REFERENCES org_seasons,
  venue_id        uuid REFERENCES venues,               -- campus
  pathway_id      uuid REFERENCES academy_pathways,     -- optional: the pathway whose level this curriculum teaches
  level_key       text CHECK (level_key IS NULL OR length(level_key) <= 40),
  stage_key       text CHECK (stage_key IS NULL OR length(stage_key) <= 40),   -- the methodology stage this curriculum teaches
  age_min         int CHECK (age_min IS NULL OR age_min BETWEEN 3 AND 99),
  age_max         int CHECK (age_max IS NULL OR age_max BETWEEN 3 AND 99),
  title           text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  current_version int  NOT NULL DEFAULT 0,               -- last published version
  row_version     int  NOT NULL DEFAULT 1,
  created_by      uuid REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (age_min IS NULL OR age_max IS NULL OR age_min <= age_max),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX IF NOT EXISTS academy_curricula_org ON academy_curricula (organisation_id, status);
CREATE INDEX IF NOT EXISTS academy_curricula_parent ON academy_curricula (parent_id) WHERE parent_id IS NOT NULL;

-- Versions: draft -> submitted -> approved (Technical Director) -> published (superseded when a later one is published). Objectives are frozen once submitted.
CREATE TABLE IF NOT EXISTS academy_curriculum_versions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  curriculum_id       uuid NOT NULL REFERENCES academy_curricula,
  version             int  NOT NULL,
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected','published','superseded')),
  methodology_version int  NOT NULL,
  objectives          jsonb NOT NULL DEFAULT '[]',  -- [{key,title,competency_key,priority,mastery_target,success_criteria,rpe_target,phase_keys,assess,sessions_target,drill_keys,guardian_summary,op}]
  phases              jsonb NOT NULL DEFAULT '[]',  -- periodisation [{key,title,starts_on,ends_on,intensity,focus_keys,note}]
  effective_from      date NOT NULL DEFAULT current_date,
  effective_to        date,
  note                text CHECK (note IS NULL OR length(note) <= 300),
  submitted_by        uuid REFERENCES users,
  submitted_at        timestamptz,
  decided_by          uuid REFERENCES users,
  decided_at          timestamptz,
  decision_note       text CHECK (decision_note IS NULL OR length(decision_note) <= 500),
  self_approved       boolean NOT NULL DEFAULT false,
  published_by        uuid REFERENCES users,
  published_at        timestamptz,
  created_by          uuid REFERENCES users,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (curriculum_id, version),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_curriculum_versions_one_open ON academy_curriculum_versions (curriculum_id) WHERE status IN ('draft','submitted','approved');

-- 3. Which cohort follows which curriculum, and which coach is accountable for delivering it.
CREATE TABLE IF NOT EXISTS academy_curriculum_assignments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  curriculum_id  uuid NOT NULL REFERENCES academy_curricula,
  cohort_id      uuid NOT NULL REFERENCES org_cohorts,
  coach_id       uuid REFERENCES users,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  effective_from date NOT NULL DEFAULT current_date,
  ended_on       date,
  assigned_by    uuid REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_curriculum_assignments_live ON academy_curriculum_assignments (curriculum_id, cohort_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS academy_curriculum_assignments_cohort ON academy_curriculum_assignments (cohort_id, status);

-- 4. Objectives mapped to an academy session. The snapshot is the objective as published in the version used, and is never changed: publishing
-- version B can never rewrite what a past session was meant to teach. Only the delivery outcome columns are updated.
CREATE TABLE IF NOT EXISTS academy_session_objectives (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id           uuid NOT NULL REFERENCES academy_sessions,
  assignment_id        uuid REFERENCES academy_curriculum_assignments,
  curriculum_id        uuid NOT NULL REFERENCES academy_curricula,
  curriculum_version_id uuid NOT NULL REFERENCES academy_curriculum_versions,
  objective_key        text NOT NULL,
  snapshot             jsonb NOT NULL,
  status               text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','delivered','partly','not_delivered','removed')),
  deviation_reason     text CHECK (deviation_reason IS NULL OR deviation_reason IN ('weather','venue_unavailable','coach_absent','athlete_needs','low_attendance','safeguarding','time_overrun','schedule_change','other')),
  deviation_note       text CHECK (deviation_note IS NULL OR length(deviation_note) <= 500),
  evidence             jsonb NOT NULL DEFAULT '{}',   -- {record_id, blocks_planned, blocks_done, attested, note} taken from the coaching session record
  mapped_by            uuid REFERENCES users,
  recorded_by          uuid REFERENCES users,
  recorded_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, objective_key)
);
CREATE INDEX IF NOT EXISTS academy_session_objectives_curriculum ON academy_session_objectives (curriculum_id, status);

-- 5. Periodic reviews (append-only). The coverage figure is the snapshot at the time of review.
CREATE TABLE IF NOT EXISTS academy_curriculum_reviews (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  curriculum_id         uuid NOT NULL REFERENCES academy_curricula,
  curriculum_version_id uuid REFERENCES academy_curriculum_versions,
  reviewer_id           uuid NOT NULL REFERENCES users,
  outcome               text NOT NULL CHECK (outcome IN ('on_track','needs_attention','revise')),
  coverage              jsonb NOT NULL DEFAULT '{}',
  note                  text CHECK (note IS NULL OR length(note) <= 1000),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_curriculum_reviews_curriculum ON academy_curriculum_reviews (curriculum_id, created_at DESC);

-- Immutability guards (history is evidence): a version's content cannot change after submission; a session objective's snapshot never changes.
CREATE OR REPLACE FUNCTION academy_curriculum_freeze() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' AND (NEW.objectives IS DISTINCT FROM OLD.objectives OR NEW.phases IS DISTINCT FROM OLD.phases OR NEW.methodology_version IS DISTINCT FROM OLD.methodology_version) THEN
    RAISE EXCEPTION 'A submitted curriculum version cannot be edited; publish a new version';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS academy_curriculum_freeze_trg ON academy_curriculum_versions;
CREATE TRIGGER academy_curriculum_freeze_trg BEFORE UPDATE ON academy_curriculum_versions FOR EACH ROW EXECUTE FUNCTION academy_curriculum_freeze();

CREATE OR REPLACE FUNCTION academy_session_objective_freeze() RETURNS trigger AS $$
BEGIN
  IF NEW.snapshot IS DISTINCT FROM OLD.snapshot OR NEW.curriculum_version_id IS DISTINCT FROM OLD.curriculum_version_id OR NEW.objective_key IS DISTINCT FROM OLD.objective_key THEN
    RAISE EXCEPTION 'The objective a session was planned with cannot be rewritten';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS academy_session_objective_freeze_trg ON academy_session_objectives;
CREATE TRIGGER academy_session_objective_freeze_trg BEFORE UPDATE ON academy_session_objectives FOR EACH ROW EXECUTE FUNCTION academy_session_objective_freeze();

-- 6. Coaches confirm they have read the version in force; coaches raise structured feedback that the Technical Director resolves into the next version.
CREATE TABLE IF NOT EXISTS academy_curriculum_acks (
  curriculum_version_id uuid NOT NULL REFERENCES academy_curriculum_versions,
  user_id               uuid NOT NULL REFERENCES users,
  acknowledged_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (curriculum_version_id, user_id)
);

CREATE TABLE IF NOT EXISTS academy_curriculum_feedback (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  curriculum_id         uuid NOT NULL REFERENCES academy_curricula,
  curriculum_version_id uuid REFERENCES academy_curriculum_versions,
  objective_key         text,
  author_id             uuid NOT NULL REFERENCES users,
  kind                  text NOT NULL CHECK (kind IN ('too_easy','too_hard','too_long','unclear','missing_drill','suggestion','other')),
  note                  text NOT NULL CHECK (length(note) BETWEEN 2 AND 1000),
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','declined','done')),
  resolution_note       text CHECK (resolution_note IS NULL OR length(resolution_note) <= 500),
  resolved_by           uuid REFERENCES users,
  resolved_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_curriculum_feedback_curriculum ON academy_curriculum_feedback (curriculum_id, status, created_at DESC);
