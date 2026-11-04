-- Academy OS P0 / Gap 05 (#785): the multidisciplinary athlete development plan.
-- The plan is COORDINATION only. It never copies an athlete, a coach goal, a rubric score, an attendance record, a school report or a clinical fact:
-- every piece of evidence is resolved at read time from its canonical table (coaching_goals, coaching_observations, org_attendance, performances,
-- academic_evidence, clinical_clearances via the athlete's minimal share, academy_progression_decisions) and is referenced here by id only.
-- Additive and backwards-compatible: nothing is dropped or rewritten, no ON DELETE CASCADE, plans/objectives are archived (archived_at), never deleted.
-- Rollback: the tables are new and referenced by nothing else; a rollback deploys the previous build, which simply ignores them (data is kept).

CREATE TABLE IF NOT EXISTS academy_dev_plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations,
  athlete_id      uuid NOT NULL REFERENCES users,
  sport           text NOT NULL CHECK (length(sport) BETWEEN 2 AND 60),
  season_label    text NOT NULL CHECK (length(season_label) BETWEEN 2 AND 40),
  starts_on       date NOT NULL,
  ends_on         date NOT NULL,
  lead_id         uuid NOT NULL REFERENCES users,                        -- the named person accountable for the whole plan (technical director / head coach)
  pathway_id      uuid REFERENCES academy_pathways,                      -- the #395 pathway this plan serves; level and decisions are read from there
  focus_enc       text,                                                  -- the season focus in the lead's words (personal free text, encrypted)
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','in_review','closed')),
  review_every_days int NOT NULL DEFAULT 42 CHECK (review_every_days BETWEEN 7 AND 180),
  row_version     int NOT NULL DEFAULT 1,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  idempotency_key text,
  CHECK (ends_on > starts_on)
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_dev_plans_season ON academy_dev_plans (organisation_id, athlete_id, lower(season_label)) WHERE archived_at IS NULL;
-- Season periodisation: [{ kind, label, from, to }] (pre_season, competition, exams, recovery, transition, camp). Validated by the API; used for the timeline and clash warnings.
ALTER TABLE academy_dev_plans ADD COLUMN IF NOT EXISTS phases jsonb NOT NULL DEFAULT '[]';
CREATE INDEX IF NOT EXISTS academy_dev_plans_org ON academy_dev_plans (organisation_id, status, ends_on, id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS academy_dev_plans_athlete ON academy_dev_plans (athlete_id, ends_on DESC, id);
CREATE UNIQUE INDEX IF NOT EXISTS academy_dev_plans_idem ON academy_dev_plans (created_by, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Named contributors: the people (org members, or providers the academy is associated with) who own work in the plan and what they may see.
CREATE TABLE IF NOT EXISTS academy_dev_contributors (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id    uuid NOT NULL REFERENCES academy_dev_plans,
  user_id    uuid NOT NULL REFERENCES users,
  discipline text NOT NULL CHECK (discipline IN ('head_coach','coach','conditioning','psychology','education','nutrition','physio_provider','welfare_liaison','other')),
  domains    text[] NOT NULL DEFAULT '{}',                               -- the domains this person sees; empty = only the items they own (providers)
  added_by   uuid NOT NULL REFERENCES users,
  added_at   timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_dev_contributors_live ON academy_dev_contributors (plan_id, user_id) WHERE removed_at IS NULL;

-- A season objective inside ONE competency domain. The measurable target points at a canonical metric; the live figure is never stored here
-- (only the baseline at the time the objective was set, labelled with its date, so a trend can be drawn honestly).
CREATE TABLE IF NOT EXISTS academy_dev_objectives (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id       uuid NOT NULL REFERENCES academy_dev_plans,
  domain        text NOT NULL CHECK (domain IN ('technical','tactical','physical','mental','academic','personal')),
  competency    text CHECK (competency IS NULL OR length(competency) <= 80),   -- sport-specific competency label, from the sport's framework (src/academy-dev-catalogue.js)
  competency_key text CHECK (competency_key IS NULL OR competency_key ~ '^[a-z0-9_]{2,40}$'),
  title         text NOT NULL CHECK (length(title) BETWEEN 3 AND 140),
  rationale_enc text,
  metric_kind   text NOT NULL DEFAULT 'milestones' CHECK (metric_kind IN ('rubric','attendance','coach_goal','official','milestones')),
  rubric_id     uuid REFERENCES coaching_rubrics,
  dimension_key text,
  coach_goal_id uuid REFERENCES coaching_goals,
  official_metric text,
  target_value  numeric,
  baseline_value numeric,
  baseline_on   date,
  owner_id      uuid NOT NULL REFERENCES users,
  due_on        date,
  visibility    text NOT NULL DEFAULT 'athlete' CHECK (visibility IN ('staff','athlete')),   -- athlete = also shown to the athlete and their guardians
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('planned','active','achieved','deferred','dropped')),
  position      int NOT NULL DEFAULT 0,
  row_version   int NOT NULL DEFAULT 1,
  created_by    uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  CHECK (metric_kind <> 'rubric' OR (rubric_id IS NOT NULL AND dimension_key IS NOT NULL)),
  CHECK (metric_kind <> 'coach_goal' OR coach_goal_id IS NOT NULL),
  CHECK (metric_kind <> 'official' OR official_metric IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS academy_dev_objectives_plan ON academy_dev_objectives (plan_id, domain, position, id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS academy_dev_milestones (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  objective_id uuid NOT NULL REFERENCES academy_dev_objectives,
  title        text NOT NULL CHECK (length(title) BETWEEN 3 AND 140),
  due_on       date NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','skipped')),
  done_on      date,
  done_by      uuid REFERENCES users,
  created_by   uuid NOT NULL REFERENCES users,
  created_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz
);
CREATE INDEX IF NOT EXISTS academy_dev_milestones_obj ON academy_dev_milestones (objective_id, due_on, id) WHERE archived_at IS NULL;

-- Intervention tasks: what someone will DO. If a coach already tracks the action as a coaching action, the link points at it.
CREATE TABLE IF NOT EXISTS academy_dev_interventions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id      uuid NOT NULL REFERENCES academy_dev_plans,
  objective_id uuid REFERENCES academy_dev_objectives,
  kind         text NOT NULL CHECK (kind IN ('training_block','conditioning','psychology_session','tutoring','guardian_meeting','provider_referral','load_adjustment','video_review','other')),
  title        text NOT NULL CHECK (length(title) BETWEEN 3 AND 140),
  detail_enc   text,
  owner_id     uuid NOT NULL REFERENCES users,
  due_on       date,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','cancelled')),
  visibility   text NOT NULL DEFAULT 'staff' CHECK (visibility IN ('staff','athlete')),
  coaching_action_id uuid REFERENCES coaching_actions,
  completion_note_enc text,
  completed_at timestamptz,
  row_version  int NOT NULL DEFAULT 1,
  created_by   uuid NOT NULL REFERENCES users,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS academy_dev_interventions_plan ON academy_dev_interventions (plan_id, status, due_on, id);
CREATE INDEX IF NOT EXISTS academy_dev_interventions_owner ON academy_dev_interventions (owner_id, status);

-- Development reviews. A review freezes what was in front of the people who signed it (a labelled snapshot of the evidence, with sources), so
-- later changes to canonical records never rewrite a signed review. Sign-offs and decisions are append-only.
CREATE TABLE IF NOT EXISTS academy_dev_reviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id     uuid NOT NULL REFERENCES academy_dev_plans,
  period_from date NOT NULL,
  period_to   date NOT NULL,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','signed_off','superseded')),
  domain_notes_enc text,                                                -- JSON {domain: text}, encrypted
  summary_enc text,
  family_visible boolean NOT NULL DEFAULT false,                        -- set at sign-off; the athlete/guardian see the athlete-visible parts only after this
  snapshot    jsonb,                                                    -- frozen, athlete-visible + staff parts are split inside; set at sign-off
  signed_off_by uuid REFERENCES users,
  signed_off_at timestamptz,
  row_version int NOT NULL DEFAULT 1,
  created_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (period_to >= period_from)
);
CREATE INDEX IF NOT EXISTS academy_dev_reviews_plan ON academy_dev_reviews (plan_id, created_at DESC, id);
CREATE UNIQUE INDEX IF NOT EXISTS academy_dev_reviews_one_draft ON academy_dev_reviews (plan_id) WHERE status = 'draft';

CREATE TABLE IF NOT EXISTS academy_dev_signoffs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id  uuid NOT NULL REFERENCES academy_dev_reviews,
  user_id    uuid NOT NULL REFERENCES users,
  capacity   text NOT NULL CHECK (capacity IN ('lead','contributor','athlete','guardian')),
  decision   text NOT NULL CHECK (decision IN ('approve','acknowledge','raise_concern')),
  comment_enc text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_dev_signoffs_once ON academy_dev_signoffs (review_id, user_id, capacity);

CREATE TABLE IF NOT EXISTS academy_dev_decisions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id     uuid NOT NULL REFERENCES academy_dev_plans,
  review_id   uuid REFERENCES academy_dev_reviews,
  kind        text NOT NULL CHECK (kind IN ('continue_plan','change_focus','adjust_load','extra_academic_support','psychology_support','provider_referral','pathway_review','pause_plan','close_season')),
  reason_enc  text NOT NULL,
  progression_decision_id uuid REFERENCES academy_progression_decisions,   -- a pathway move is made in Progress; this only links to it
  decided_by  uuid NOT NULL REFERENCES users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  idempotency_key text
);
CREATE INDEX IF NOT EXISTS academy_dev_decisions_plan ON academy_dev_decisions (plan_id, created_at DESC, id);
CREATE UNIQUE INDEX IF NOT EXISTS academy_dev_decisions_idem ON academy_dev_decisions (decided_by, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- School summaries: the athlete (or a verified guardian) chooses which of THEIR academic_evidence records this plan may show, as metadata only.
CREATE TABLE IF NOT EXISTS academy_dev_school_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id     uuid NOT NULL REFERENCES academy_dev_plans,
  evidence_id uuid NOT NULL REFERENCES academic_evidence,
  linked_by   uuid NOT NULL REFERENCES users,
  linked_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  revoked_by  uuid REFERENCES users
);
CREATE UNIQUE INDEX IF NOT EXISTS academy_dev_school_links_live ON academy_dev_school_links (plan_id, evidence_id) WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION academy_dev_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
DROP TRIGGER IF EXISTS academy_dev_signoffs_immutable ON academy_dev_signoffs;
CREATE TRIGGER academy_dev_signoffs_immutable BEFORE UPDATE OR DELETE ON academy_dev_signoffs FOR EACH ROW EXECUTE FUNCTION academy_dev_append_only();
DROP TRIGGER IF EXISTS academy_dev_decisions_immutable ON academy_dev_decisions;
CREATE TRIGGER academy_dev_decisions_immutable BEFORE UPDATE OR DELETE ON academy_dev_decisions FOR EACH ROW EXECUTE FUNCTION academy_dev_append_only();
