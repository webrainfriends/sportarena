-- Officials Development & Assessment (#486). Additive only: new tables, nothing existing changes meaning and nothing is removed.
--
-- #88 stays the owner of assignments and match-day work (`fixture_officials`); the federation OS (#475) stays the owner of grades and licences
-- (`fed_licence_types`, `fed_licences`: "current grade" is always read from the licence in force, never copied). This migration adds only what is new:
-- assessor appointments, observation assignments, versioned rubrics, formal assessments (immutable versions) with acknowledgement and appeal,
-- grade requirements that the existing licence approval consumes, mentoring, development items, CPD records and fitness/competency results.
-- Formal assessments are private development records. They never touch public feedback (#215), fixture results or disciplinary cases.
-- Rollback = deploy the previous code; it ignores these tables, which can stay in place unused.

-- Immutable decision history for everything below. Rows are never updated or deleted.
CREATE TABLE off_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id      uuid NOT NULL REFERENCES governing_bodies,
  subject_type text NOT NULL CHECK (subject_type IN ('assessor','observation','assessment','appeal','rubric','mentorship','cpd','fitness','requirement','settings')),
  subject_id   uuid NOT NULL,
  action       text NOT NULL,
  from_status  text,
  to_status    text,
  actor_id     uuid REFERENCES users,
  reason       text CHECK (reason IS NULL OR length(reason) <= 500),
  detail       jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX off_events_subject ON off_events (subject_type, subject_id, created_at);
CREATE INDEX off_events_body ON off_events (body_id, created_at DESC);
CREATE FUNCTION off_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER off_events_append_only BEFORE UPDATE OR DELETE ON off_events FOR EACH ROW EXECUTE FUNCTION off_append_only();

-- Per-body policy for how assessments reach the official.
CREATE TABLE off_settings (
  body_id              uuid PRIMARY KEY REFERENCES governing_bodies,
  publication          text NOT NULL DEFAULT 'on_submit' CHECK (publication IN ('on_submit','after_review')),
  appeal_window_days   integer NOT NULL DEFAULT 14 CHECK (appeal_window_days BETWEEN 1 AND 90),
  disclose_observation boolean NOT NULL DEFAULT true,
  updated_by           uuid REFERENCES users,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ assessors
-- An appointment is explicit authority. It rests on the person's own current licence (read live, never copied), so it lapses with that licence.
CREATE TABLE off_assessors (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id              uuid NOT NULL REFERENCES governing_bodies,
  user_id              uuid NOT NULL REFERENCES users,
  sport_id             uuid NOT NULL REFERENCES sports,
  discipline           text NOT NULL DEFAULT '' CHECK (length(discipline) <= 60),
  official_roles       text[] NOT NULL DEFAULT '{referee,umpire,linesman,scorer}' CHECK (official_roles <@ ARRAY['referee','umpire','linesman','scorer']),
  max_grade_rank       integer NOT NULL DEFAULT 20 CHECK (max_grade_rank BETWEEN 0 AND 20),
  scope_event_id       uuid REFERENCES events,
  credential_licence_id uuid NOT NULL REFERENCES fed_licences,
  valid_from           date NOT NULL DEFAULT current_date,
  valid_until          date NOT NULL,
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
  status_reason        text CHECK (status_reason IS NULL OR length(status_reason) <= 500),
  appointed_by         uuid NOT NULL REFERENCES users,
  created_at           timestamptz NOT NULL DEFAULT now(),
  ended_at             timestamptz,
  CHECK (valid_until >= valid_from),
  CHECK (cardinality(official_roles) > 0)
);
CREATE UNIQUE INDEX off_assessors_live ON off_assessors (body_id, user_id, sport_id, discipline, coalesce(scope_event_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE status IN ('active','suspended');
CREATE INDEX off_assessors_user ON off_assessors (user_id, status);

-- ------------------------------------------------------------------ rubrics
CREATE TABLE off_rubrics (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id        uuid NOT NULL REFERENCES governing_bodies,
  sport_id       uuid NOT NULL REFERENCES sports,
  official_role  text NOT NULL CHECK (official_role IN ('referee','umpire','linesman','scorer')),
  name           text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  min_grade_rank integer NOT NULL DEFAULT 0 CHECK (min_grade_rank BETWEEN 0 AND 20),
  max_grade_rank integer NOT NULL DEFAULT 20 CHECK (max_grade_rank BETWEEN 0 AND 20),
  archived_at    timestamptz,
  created_by     uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (max_grade_rank >= min_grade_rank)
);
CREATE UNIQUE INDEX off_rubrics_name ON off_rubrics (body_id, sport_id, official_role, lower(name)) WHERE archived_at IS NULL;

-- Each version is immutable: a published scale or dimension never changes under an assessment that used it.
CREATE TABLE off_rubric_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rubric_id    uuid NOT NULL REFERENCES off_rubrics,
  version      integer NOT NULL CHECK (version >= 1),
  scale        jsonb NOT NULL,      -- {min, max, labels: {"1": "...", ...}}
  dimensions   jsonb NOT NULL,      -- [{key, label, description, evidence_expectation, allow_na}]
  published_by uuid NOT NULL REFERENCES users,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rubric_id, version)
);
CREATE TRIGGER off_rubric_versions_immutable BEFORE UPDATE OR DELETE ON off_rubric_versions FOR EACH ROW EXECUTE FUNCTION off_append_only();

-- ------------------------------------------------------------------ observations (who assesses whom, at which fixture)
CREATE TABLE off_observations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id             uuid NOT NULL REFERENCES governing_bodies,
  fixture_id          uuid NOT NULL REFERENCES fixtures,
  fixture_official_id uuid NOT NULL REFERENCES fixture_officials,
  official_id         uuid NOT NULL REFERENCES users,
  assessor_id         uuid NOT NULL REFERENCES users,
  assessor_appointment_id uuid NOT NULL REFERENCES off_assessors,
  sport_id            uuid NOT NULL REFERENCES sports,
  official_role       text NOT NULL,
  purpose             text NOT NULL CHECK (purpose IN ('routine','promotion','mentoring','probation','return','other')),
  purpose_note        text CHECK (purpose_note IS NULL OR length(purpose_note) <= 300),
  due_on              date,
  status              text NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','accepted','declined','completed','cancelled')),
  coi_declared        boolean,
  coi_note_enc        text,
  accepted_at         timestamptz,
  assigned_by         uuid NOT NULL REFERENCES users,
  created_at          timestamptz NOT NULL DEFAULT now(),
  closed_at           timestamptz,
  row_version         integer NOT NULL DEFAULT 1,
  CHECK (assessor_id <> official_id)
);
CREATE UNIQUE INDEX off_observations_open ON off_observations (fixture_official_id, assessor_id) WHERE status IN ('assigned','accepted');
CREATE INDEX off_observations_assessor ON off_observations (assessor_id, status);
CREATE INDEX off_observations_official ON off_observations (official_id, status);
CREATE INDEX off_observations_body ON off_observations (body_id, status, due_on);

-- ------------------------------------------------------------------ assessments
CREATE TABLE off_assessments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id   uuid NOT NULL UNIQUE REFERENCES off_observations,
  body_id          uuid NOT NULL REFERENCES governing_bodies,
  official_id      uuid NOT NULL REFERENCES users,
  assessor_id      uuid NOT NULL REFERENCES users,
  fixture_id       uuid NOT NULL REFERENCES fixtures,
  sport_id         uuid NOT NULL REFERENCES sports,
  official_role    text NOT NULL,
  rubric_version_id uuid NOT NULL REFERENCES off_rubric_versions,
  grade_label      text NOT NULL DEFAULT '',        -- the grade held at the time: a historical fact, never read for eligibility
  grade_rank       integer,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','published','voided')),
  current_version  integer NOT NULL DEFAULT 1,
  submitted_at     timestamptz,
  published_at     timestamptz,
  void_reason      text CHECK (void_reason IS NULL OR length(void_reason) <= 500),
  voided_by        uuid REFERENCES users,
  voided_at        timestamptz,
  row_version      integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (assessor_id <> official_id)
);
CREATE INDEX off_assessments_official ON off_assessments (official_id, status, published_at DESC);
CREATE INDEX off_assessments_body ON off_assessments (body_id, status);

CREATE TABLE off_assessment_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id     uuid NOT NULL REFERENCES off_assessments,
  version           integer NOT NULL CHECK (version >= 1),
  state             text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','final')),
  scores            jsonb NOT NULL DEFAULT '[]',     -- [{key, score|null, na, evidence}] against the rubric version
  narrative_enc     text,                            -- encrypted JSON: strengths, development areas, required actions, observations, mentoring/training
  recommendation    text CHECK (recommendation IS NULL OR recommendation IN ('maintain_grade','ready_for_review','further_observation')),
  correction_reason text CHECK (correction_reason IS NULL OR length(correction_reason) <= 500),
  created_by        uuid NOT NULL REFERENCES users,
  created_at        timestamptz NOT NULL DEFAULT now(),
  finalised_at      timestamptz,
  UNIQUE (assessment_id, version)
);
-- A final version can never be edited or removed; only a draft may change. A negative assessment cannot be silently deleted to improve a record.
CREATE FUNCTION off_assessment_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.state = 'final' THEN RAISE EXCEPTION 'a final assessment version is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER off_assessment_versions_guard BEFORE UPDATE OR DELETE ON off_assessment_versions FOR EACH ROW EXECUTE FUNCTION off_assessment_versions_guard();

-- The official's acknowledgements and comments on a version. Append-only.
CREATE TABLE off_assessment_responses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id uuid NOT NULL REFERENCES off_assessments,
  version       integer NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('acknowledgement','comment')),
  body_enc      text,
  by_user       uuid NOT NULL REFERENCES users,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX off_assessment_responses_a ON off_assessment_responses (assessment_id, created_at);
CREATE TRIGGER off_assessment_responses_append_only BEFORE UPDATE OR DELETE ON off_assessment_responses FOR EACH ROW EXECUTE FUNCTION off_append_only();

-- Review requests and appeals. Decisions never delete; an upheld appeal leads to a corrected version or a void, both kept in history.
CREATE TABLE off_appeals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id uuid NOT NULL REFERENCES off_assessments,
  body_id       uuid NOT NULL REFERENCES governing_bodies,
  version       integer NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('review','appeal')),
  grounds_enc   text NOT NULL,
  status        text NOT NULL DEFAULT 'lodged' CHECK (status IN ('lodged','under_review','upheld','partly_upheld','dismissed','withdrawn')),
  decision_enc  text,
  lodged_by     uuid NOT NULL REFERENCES users,
  decided_by    uuid REFERENCES users,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  row_version   integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX off_appeals_open ON off_appeals (assessment_id, kind) WHERE status IN ('lodged','under_review');
CREATE INDEX off_appeals_body ON off_appeals (body_id, status);

-- ------------------------------------------------------------------ progression requirements
-- What a licence type asks of an official beyond the licence checks it already has. The existing licence approval reads these live: nothing is copied
-- onto the licence, and a raw score never promotes anyone (only counts of assessor recommendations, hours and tests are checked, and a person decides).
CREATE TABLE off_grade_requirements (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id                   uuid NOT NULL REFERENCES governing_bodies,
  licence_type_id           uuid NOT NULL REFERENCES fed_licence_types,
  version                   integer NOT NULL DEFAULT 1,
  prerequisite_type_id      uuid REFERENCES fed_licence_types,
  min_months_at_prerequisite integer NOT NULL DEFAULT 0 CHECK (min_months_at_prerequisite BETWEEN 0 AND 240),
  min_assessments           integer NOT NULL DEFAULT 0 CHECK (min_assessments BETWEEN 0 AND 100),
  min_favourable            integer NOT NULL DEFAULT 0 CHECK (min_favourable BETWEEN 0 AND 100),
  require_promotion_assessment boolean NOT NULL DEFAULT false,
  assessment_window_months  integer NOT NULL DEFAULT 12 CHECK (assessment_window_months BETWEEN 1 AND 120),
  cpd_hours                 numeric(6,1) NOT NULL DEFAULT 0 CHECK (cpd_hours >= 0),
  cpd_window_months         integer NOT NULL DEFAULT 12 CHECK (cpd_window_months BETWEEN 1 AND 120),
  fitness_test_type_id      uuid,
  created_by                uuid NOT NULL REFERENCES users,
  created_at                timestamptz NOT NULL DEFAULT now(),
  superseded_at             timestamptz,
  CHECK (min_favourable <= min_assessments OR min_assessments = 0)
);
CREATE UNIQUE INDEX off_grade_requirements_live ON off_grade_requirements (licence_type_id) WHERE superseded_at IS NULL;

-- ------------------------------------------------------------------ fitness / competency
CREATE TABLE off_fitness_test_types (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id         uuid NOT NULL REFERENCES governing_bodies,
  sport_id        uuid REFERENCES sports,
  name            text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  version         text NOT NULL DEFAULT '1' CHECK (length(version) BETWEEN 1 AND 20),
  result_kind     text NOT NULL DEFAULT 'pass_fail' CHECK (result_kind IN ('pass_fail','measured')),
  unit            text CHECK (unit IS NULL OR length(unit) <= 20),
  pass_direction  text CHECK (pass_direction IS NULL OR pass_direction IN ('at_least','at_most')),
  pass_threshold  numeric(10,2),
  validity_months integer NOT NULL DEFAULT 12 CHECK (validity_months BETWEEN 1 AND 60),
  archived_at     timestamptz,
  created_by      uuid NOT NULL REFERENCES users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (result_kind = 'pass_fail' OR (unit IS NOT NULL AND pass_direction IS NOT NULL AND pass_threshold IS NOT NULL))
);
CREATE UNIQUE INDEX off_fitness_test_types_name ON off_fitness_test_types (body_id, lower(name), version) WHERE archived_at IS NULL;
ALTER TABLE off_grade_requirements ADD CONSTRAINT off_grade_requirements_fitness FOREIGN KEY (fitness_test_type_id) REFERENCES off_fitness_test_types;

-- Operational result only: no clinical data, no diagnosis. Measured values exist only when the test type is measured, and only the official and
-- the body's licensing staff can read them. A wrong entry is voided with a reason, never deleted.
CREATE TABLE off_fitness_results (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id        uuid NOT NULL REFERENCES governing_bodies,
  test_type_id   uuid NOT NULL REFERENCES off_fitness_test_types,
  official_id    uuid NOT NULL REFERENCES users,
  taken_on       date NOT NULL,
  outcome        text NOT NULL CHECK (outcome IN ('pass','fail','completed')),
  measured_value numeric(10,2),
  provider       text CHECK (provider IS NULL OR length(provider) <= 120),
  reference_enc  text,
  valid_until    date NOT NULL,
  recorded_by    uuid NOT NULL REFERENCES users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  voided_at      timestamptz,
  void_reason    text CHECK (void_reason IS NULL OR length(void_reason) <= 300),
  CHECK (valid_until >= taken_on)
);
CREATE INDEX off_fitness_results_official ON off_fitness_results (official_id, test_type_id, taken_on DESC);

-- ------------------------------------------------------------------ CPD
-- A record of learning. When it is backed by an issued credential (education pathways) the credential is the source and nothing is re-typed;
-- a self-reported record counts only after the body's licensing staff verify it.
CREATE TABLE off_cpd_records (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id        uuid NOT NULL REFERENCES governing_bodies,
  user_id        uuid NOT NULL REFERENCES users,
  sport_id       uuid REFERENCES sports,
  kind           text NOT NULL CHECK (kind IN ('course','module','workshop','conference','mentoring','other')),
  title          text NOT NULL CHECK (length(title) BETWEEN 2 AND 160),
  provider_name  text CHECK (provider_name IS NULL OR length(provider_name) <= 120),
  provider_org_id uuid REFERENCES organisations,
  credential_id  uuid REFERENCES credentials,
  completed_on   date NOT NULL,
  hours          numeric(5,1) NOT NULL DEFAULT 0 CHECK (hours >= 0 AND hours <= 500),
  credits        numeric(5,1) NOT NULL DEFAULT 0 CHECK (credits >= 0 AND credits <= 500),
  expires_on     date,
  evidence_enc   text,
  status         text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','verified','rejected','withdrawn')),
  decision_reason text CHECK (decision_reason IS NULL OR length(decision_reason) <= 300),
  decided_by     uuid REFERENCES users,
  decided_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_on IS NULL OR expires_on >= completed_on)
);
CREATE UNIQUE INDEX off_cpd_credential ON off_cpd_records (user_id, body_id, credential_id) WHERE credential_id IS NOT NULL AND status IN ('recorded','verified');
CREATE INDEX off_cpd_user ON off_cpd_records (user_id, body_id, status, completed_on DESC);

-- ------------------------------------------------------------------ mentoring and development items
CREATE TABLE off_mentorships (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id            uuid NOT NULL REFERENCES governing_bodies,
  mentor_id          uuid NOT NULL REFERENCES users,
  mentee_id          uuid NOT NULL REFERENCES users,
  sport_id           uuid NOT NULL REFERENCES sports,
  scope_enc          text,
  starts_on          date NOT NULL DEFAULT current_date,
  ends_on            date,
  status             text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','active','completed','ended','declined')),
  mentor_accepted_at timestamptz,
  mentee_accepted_at timestamptz,
  created_by         uuid NOT NULL REFERENCES users,
  end_reason         text CHECK (end_reason IS NULL OR length(end_reason) <= 300),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (mentor_id <> mentee_id),
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE UNIQUE INDEX off_mentorships_live ON off_mentorships (mentor_id, mentee_id, sport_id) WHERE status IN ('proposed','active');
CREATE INDEX off_mentorships_mentee ON off_mentorships (mentee_id, status);

-- Goals, actions and meetings. Actions from a published assessment arrive here too, so there is one list of "what I am working on".
CREATE TABLE off_dev_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_id       uuid NOT NULL REFERENCES governing_bodies,
  official_id   uuid NOT NULL REFERENCES users,
  kind          text NOT NULL CHECK (kind IN ('goal','action','meeting')),
  source_type   text NOT NULL CHECK (source_type IN ('assessment','mentorship','self','body')),
  source_id     uuid,
  source_ref    text,
  mentorship_id uuid REFERENCES off_mentorships,
  title_enc     text NOT NULL,
  detail_enc    text,
  visibility    text NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared','mentor_only')),
  due_on        date,
  happened_on   date,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  created_by    uuid NOT NULL REFERENCES users,
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (visibility = 'shared' OR mentorship_id IS NOT NULL)
);
CREATE UNIQUE INDEX off_dev_items_source ON off_dev_items (source_type, source_id, source_ref) WHERE source_id IS NOT NULL AND source_ref IS NOT NULL;
CREATE INDEX off_dev_items_official ON off_dev_items (official_id, status, due_on);
CREATE INDEX off_dev_items_mentorship ON off_dev_items (mentorship_id) WHERE mentorship_id IS NOT NULL;
