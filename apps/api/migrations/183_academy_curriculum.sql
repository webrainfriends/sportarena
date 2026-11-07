-- Academy OS P0 / Gap 02 — Coaching Philosophy, Curriculum & Methodology Governance (#782).
-- Purely additive: new tables only, nothing existing is altered, nothing is deleted.
--
-- Data model summary:
--   Methodology  → MethodologyVersion  (sport-specific institutional library: philosophy, game model,
--                                        stage ladder, competencies, drills, outcomes; append-only versions)
--   Curriculum   → CurriculumVersion   (versioned, TD-approved teaching plan per cohort scope)
--   Assignment                         (links a curriculum version to a cohort; optional coach override)
--   SessionObjective                   (snapshot of objectives at session time; never rewritten when
--                                        a new version is published — immutability is the guarantee)
--   CurriculumReview                   (periodic quality / coverage review by TD or assessor)
--   CurriculumAck                      (coach acknowledgement on publish; required before season start)
--   CurriculumFeedback                 (coach-submitted improvement requests; TD resolves)
--
-- No ON DELETE CASCADE anywhere.  Soft-deletes: status/archived flags only.
-- Personal fields: coach display_name and athlete enrolment data stay in existing tables; no PII here.
-- Rollback: drop the tables and indexes below (all are new; they reference nothing that depends on them).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Methodology library
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE academy_methodologies (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid        NOT NULL REFERENCES organisations,
  sport           text        NOT NULL,
  title           text        NOT NULL,
  status          text        NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft','active','archived')),
  current_version int,
  row_version     int         NOT NULL DEFAULT 0,
  created_by      uuid        NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, sport, title)
);

CREATE TABLE academy_methodology_versions (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  methodology_id uuid        NOT NULL REFERENCES academy_methodologies,
  version        int         NOT NULL,
  philosophy     jsonb       NOT NULL DEFAULT '{}',   -- {statement, values[], principles[], standards[]}
  game_model     jsonb       NOT NULL DEFAULT '{}',   -- game phases array
  stages         jsonb       NOT NULL DEFAULT '[]',   -- age-band ladder
  competencies   jsonb       NOT NULL DEFAULT '[]',   -- [{pillar, title, rubric_id?, proficiency_per_stage{}}]
  drills         jsonb       NOT NULL DEFAULT '[]',   -- approved drill templates
  outcomes       jsonb       NOT NULL DEFAULT '[]',   -- [{competency_key, stage, age_min, age_max, level, position, outcome}]
  standards      jsonb       NOT NULL DEFAULT '{}',   -- quality floor config
  effective_from date        NOT NULL DEFAULT current_date,
  note           text,
  created_by     uuid        NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (methodology_id, version)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Curriculum
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE academy_curricula (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid        NOT NULL REFERENCES organisations,
  methodology_id  uuid        NOT NULL REFERENCES academy_methodologies,
  parent_id       uuid        REFERENCES academy_curricula,     -- inheritance chain (max depth 4)
  season_id       uuid        REFERENCES org_seasons,
  venue_id        uuid        REFERENCES venues,
  pathway_id      uuid        REFERENCES academy_pathways,
  level_key       text,
  stage_key       text,
  age_min         int,
  age_max         int,
  title           text        NOT NULL,
  status          text        NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft','active','archived')),
  current_version int,
  row_version     int         NOT NULL DEFAULT 0,
  created_by      uuid        NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE academy_curriculum_versions (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  curriculum_id       uuid        NOT NULL REFERENCES academy_curricula,
  version             int         NOT NULL,
  methodology_version int         NOT NULL,           -- version number (not FK) — snapshot; stable forever
  objectives          jsonb       NOT NULL DEFAULT '[]',
  phases              jsonb       NOT NULL DEFAULT '[]',
  effective_from      date,
  effective_to        date,
  note                text,
  status              text        NOT NULL DEFAULT 'draft'
                                  CHECK (status IN ('draft','submitted','approved','rejected','published','superseded')),
  submitted_by        uuid        REFERENCES users,
  submitted_at        timestamptz,
  decided_by          uuid        REFERENCES users,
  decided_at          timestamptz,
  decision_note       text,
  self_approved       boolean     NOT NULL DEFAULT false,
  published_by        uuid        REFERENCES users,
  published_at        timestamptz,
  created_by          uuid        NOT NULL REFERENCES users,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (curriculum_id, version)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Coach assignment (curriculum → cohort binding)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE academy_curriculum_assignments (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  curriculum_id  uuid        NOT NULL REFERENCES academy_curricula,
  cohort_id      uuid        NOT NULL REFERENCES org_cohorts,
  coach_id       uuid        REFERENCES users,          -- null = cohort's default coach
  effective_from date        NOT NULL DEFAULT current_date,
  ended_on       date,
  status         text        NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active','ended')),
  assigned_by    uuid        NOT NULL REFERENCES users,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Session objectives — immutable snapshot; never rewritten after publish
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE academy_session_objectives (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id            uuid        NOT NULL REFERENCES academy_sessions,
  assignment_id         uuid        REFERENCES academy_curriculum_assignments,
  curriculum_id         uuid        NOT NULL REFERENCES academy_curricula,
  curriculum_version_id uuid        NOT NULL REFERENCES academy_curriculum_versions,
  objective_key         text        NOT NULL,
  snapshot              jsonb       NOT NULL DEFAULT '{}',   -- frozen copy of objective at map time
  status                text        NOT NULL DEFAULT 'planned'
                                    CHECK (status IN ('planned','delivered','partly','not_delivered','removed')),
  deviation_reason      text        CHECK (
    deviation_reason IS NULL OR deviation_reason IN (
      'weather','venue_unavailable','coach_absent','athlete_needs',
      'low_attendance','safeguarding','time_overrun','schedule_change','other'
    )
  ),
  deviation_note        text,
  evidence              jsonb       NOT NULL DEFAULT '{}',   -- block counts from coach's coaching record
  mapped_by             uuid        NOT NULL REFERENCES users,
  recorded_by           uuid        REFERENCES users,
  recorded_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, objective_key)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Coach acknowledgement (required after each publish before season starts)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE academy_curriculum_acks (
  curriculum_version_id uuid        NOT NULL REFERENCES academy_curriculum_versions,
  user_id               uuid        NOT NULL REFERENCES users,
  acked_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (curriculum_version_id, user_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Periodic TD / assessor coverage review
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE academy_curriculum_reviews (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  curriculum_id         uuid        NOT NULL REFERENCES academy_curricula,
  curriculum_version_id uuid        REFERENCES academy_curriculum_versions,
  reviewer_id           uuid        NOT NULL REFERENCES users,
  outcome               text        NOT NULL
                                    CHECK (outcome IN ('on_track','needs_attention','critical')),
  coverage              jsonb       NOT NULL DEFAULT '{}',   -- cohort coverage snapshot at review time
  note                  text,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Coach feedback on curriculum / objectives (resolved by TD)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE academy_curriculum_feedback (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  curriculum_id         uuid        NOT NULL REFERENCES academy_curricula,
  curriculum_version_id uuid        REFERENCES academy_curriculum_versions,
  objective_key         text,
  author_id             uuid        NOT NULL REFERENCES users,
  kind                  text        NOT NULL
                                    CHECK (kind IN ('too_hard','too_easy','unclear','drill_issue','scheduling','other')),
  note                  text        NOT NULL,
  status                text        NOT NULL DEFAULT 'open'
                                    CHECK (status IN ('open','acknowledged','resolved','declined')),
  resolution_note       text,
  resolved_by           uuid        REFERENCES users,
  resolved_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Indexes for common query patterns
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX ON academy_methodologies (organisation_id, sport);
CREATE INDEX ON academy_methodologies (status);
CREATE INDEX ON academy_methodology_versions (methodology_id, version);

CREATE INDEX ON academy_curricula (organisation_id, sport) WHERE status <> 'archived';
CREATE INDEX ON academy_curricula (methodology_id);
CREATE INDEX ON academy_curricula (parent_id) WHERE parent_id IS NOT NULL;

CREATE INDEX ON academy_curriculum_versions (curriculum_id, status);
CREATE INDEX ON academy_curriculum_versions (status)
  WHERE status IN ('submitted','approved');

CREATE INDEX ON academy_curriculum_assignments (curriculum_id, status);
CREATE INDEX ON academy_curriculum_assignments (cohort_id, status);
CREATE INDEX ON academy_curriculum_assignments (coach_id, status) WHERE coach_id IS NOT NULL;

CREATE INDEX ON academy_session_objectives (session_id, status);
CREATE INDEX ON academy_session_objectives (curriculum_version_id);
CREATE INDEX ON academy_session_objectives (assignment_id) WHERE assignment_id IS NOT NULL;
-- deviation analysis
CREATE INDEX ON academy_session_objectives (curriculum_id, deviation_reason)
  WHERE deviation_reason IS NOT NULL;

CREATE INDEX ON academy_curriculum_acks (user_id);

CREATE INDEX ON academy_curriculum_reviews (curriculum_id, created_at DESC);
CREATE INDEX ON academy_curriculum_feedback (curriculum_id, status);
CREATE INDEX ON academy_curriculum_feedback (author_id);
