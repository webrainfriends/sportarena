-- Referee Education, Exams & Progression (#1011)
-- Additive only. No DROP, no ON DELETE CASCADE on user data.
-- Owners: governing_bodies, fed_licences, credentials, off_events, off_rubrics.

-- ------------------------------------------------------------------ course catalogue

CREATE TABLE IF NOT EXISTS off_edu_courses (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  governing_body_id       uuid NOT NULL REFERENCES governing_bodies(id),
  sport_id                uuid REFERENCES sports(id),
  title                   text NOT NULL CHECK (char_length(title) BETWEEN 2 AND 200),
  kind                    text NOT NULL CHECK (kind IN ('theory','practical','blended','online','assessment')),
  level                   text NOT NULL CHECK (level IN ('foundation','developing','performance','elite','national')),
  description_enc         text,
  syllabus                jsonb,
  learning_objectives     text[],
  cpd_hours               numeric(5,2) NOT NULL DEFAULT 0 CHECK (cpd_hours >= 0),
  credit_units            smallint DEFAULT 0,
  min_grade_rank          smallint,
  duration_hours          numeric(5,1),
  validity_months         smallint CHECK (validity_months > 0),
  grading_schema          text CHECK (grading_schema IN ('pass_fail','percentage','grade','competency')),
  pass_mark               numeric(5,2) CHECK (pass_mark BETWEEN 0 AND 100),
  exam_attempts_allowed   smallint DEFAULT 3 CHECK (exam_attempts_allowed BETWEEN 1 AND 10),
  practical_required      boolean NOT NULL DEFAULT false,
  attendance_required_pct numeric(5,2) DEFAULT 100 CHECK (attendance_required_pct BETWEEN 0 AND 100),
  price_amount            numeric(12,2) CHECK (price_amount >= 0),
  price_currency          char(3),
  pricebook_item_id       uuid,
  status                  text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  published_at            timestamptz,
  archived_at             timestamptz,
  row_version             integer NOT NULL DEFAULT 1,
  created_by              uuid NOT NULL REFERENCES users(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_off_edu_courses_body   ON off_edu_courses(governing_body_id);
CREATE INDEX IF NOT EXISTS idx_off_edu_courses_sport  ON off_edu_courses(sport_id) WHERE sport_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_off_edu_courses_status ON off_edu_courses(status);

-- ------------------------------------------------------------------ prerequisites

CREATE TABLE IF NOT EXISTS off_edu_course_prerequisites (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id               uuid NOT NULL REFERENCES off_edu_courses(id),
  required_course_id      uuid REFERENCES off_edu_courses(id),
  required_credential_kind text,
  validity_months         smallint CHECK (validity_months > 0),
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_prereq_target CHECK (required_course_id IS NOT NULL OR required_credential_kind IS NOT NULL),
  UNIQUE (course_id, required_course_id)
);

-- ------------------------------------------------------------------ course runs

CREATE TABLE IF NOT EXISTS off_edu_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id           uuid NOT NULL REFERENCES off_edu_courses(id),
  run_code            text,
  delivery_mode       text NOT NULL DEFAULT 'in_person' CHECK (delivery_mode IN ('in_person','online','hybrid')),
  venue_id            uuid,
  venue_name_at_time  text,
  instructor_ids      uuid[],
  start_date          date NOT NULL,
  end_date            date NOT NULL,
  max_enrolments      smallint CHECK (max_enrolments > 0),
  enrolment_deadline  date,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','in_progress','completed','cancelled')),
  notes_enc           text,
  row_version         integer NOT NULL DEFAULT 1,
  created_by          uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_run_dates CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_off_edu_runs_course ON off_edu_runs(course_id);
CREATE INDEX IF NOT EXISTS idx_off_edu_runs_status ON off_edu_runs(status);

-- ------------------------------------------------------------------ sessions (for attendance)

CREATE TABLE IF NOT EXISTS off_edu_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           uuid NOT NULL REFERENCES off_edu_runs(id),
  session_number   smallint NOT NULL CHECK (session_number > 0),
  title            text,
  scheduled_at     timestamptz NOT NULL,
  duration_minutes smallint CHECK (duration_minutes > 0),
  topic            text,
  is_practical     boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, session_number)
);

CREATE INDEX IF NOT EXISTS idx_off_edu_sessions_run ON off_edu_sessions(run_id);

-- ------------------------------------------------------------------ enrolments

CREATE TABLE IF NOT EXISTS off_edu_enrolments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            uuid NOT NULL REFERENCES off_edu_runs(id),
  licence_id        uuid NOT NULL REFERENCES fed_licences(id),
  user_id           uuid NOT NULL REFERENCES users(id),
  status            text NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','enrolled','attending','completed','failed','withdrawn','waitlisted')),
  enrolment_date    date,
  completion_date   date,
  final_score       numeric(5,2) CHECK (final_score BETWEEN 0 AND 100),
  outcome           text CHECK (outcome IN ('pass','fail','distinction','merit','competent','not_yet_competent')),
  withdrawal_reason text,
  invoice_id        uuid,
  idempotency_key   text UNIQUE,
  row_version       integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_off_edu_enrolments_uniq
  ON off_edu_enrolments(run_id, licence_id)
  WHERE status NOT IN ('withdrawn');

CREATE INDEX IF NOT EXISTS idx_off_edu_enrolments_user    ON off_edu_enrolments(user_id);
CREATE INDEX IF NOT EXISTS idx_off_edu_enrolments_licence ON off_edu_enrolments(licence_id);
CREATE INDEX IF NOT EXISTS idx_off_edu_enrolments_status  ON off_edu_enrolments(status);

-- ------------------------------------------------------------------ attendance

CREATE TABLE IF NOT EXISTS off_edu_attendance (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES off_edu_sessions(id),
  enrolment_id  uuid NOT NULL REFERENCES off_edu_enrolments(id),
  status        text NOT NULL DEFAULT 'present' CHECK (status IN ('present','absent','excused','late')),
  marked_by     uuid NOT NULL REFERENCES users(id),
  marked_at     timestamptz NOT NULL DEFAULT now(),
  note          text,
  UNIQUE (session_id, enrolment_id)
);

CREATE INDEX IF NOT EXISTS idx_off_edu_attendance_session    ON off_edu_attendance(session_id);
CREATE INDEX IF NOT EXISTS idx_off_edu_attendance_enrolment  ON off_edu_attendance(enrolment_id);

-- ------------------------------------------------------------------ exams

CREATE TABLE IF NOT EXISTS off_edu_exams (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id            uuid NOT NULL REFERENCES off_edu_courses(id),
  title                text NOT NULL CHECK (char_length(title) BETWEEN 2 AND 200),
  kind                 text NOT NULL CHECK (kind IN ('theory','practical_written','scenario','mcq','short_answer')),
  instructions         text,
  time_limit_minutes   smallint CHECK (time_limit_minutes > 0),
  pass_mark            numeric(5,2) CHECK (pass_mark BETWEEN 0 AND 100),
  max_attempts         smallint NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  randomise_questions  boolean NOT NULL DEFAULT true,
  show_answers_after   text CHECK (show_answers_after IN ('immediately','after_deadline','never')),
  is_practical         boolean NOT NULL DEFAULT false,
  weight               numeric(5,2) NOT NULL DEFAULT 100 CHECK (weight > 0),
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  row_version          integer NOT NULL DEFAULT 1,
  created_by           uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_off_edu_exams_course ON off_edu_exams(course_id);

-- ------------------------------------------------------------------ exam questions

CREATE TABLE IF NOT EXISTS off_edu_exam_questions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id            uuid NOT NULL REFERENCES off_edu_exams(id),
  seq                smallint NOT NULL CHECK (seq > 0),
  kind               text NOT NULL CHECK (kind IN ('mcq','true_false','short_answer','scenario','practical')),
  stem               text NOT NULL CHECK (char_length(stem) BETWEEN 1 AND 2000),
  options            jsonb,
  correct_key        text,
  correct_answer_enc text,
  marks              numeric(5,2) NOT NULL DEFAULT 1 CHECK (marks > 0),
  mandatory          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exam_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_off_edu_questions_exam ON off_edu_exam_questions(exam_id);

-- ------------------------------------------------------------------ exam attempts (sealed after submission)

CREATE TABLE IF NOT EXISTS off_edu_exam_attempts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id        uuid NOT NULL REFERENCES off_edu_exams(id),
  enrolment_id   uuid NOT NULL REFERENCES off_edu_enrolments(id),
  attempt_number smallint NOT NULL CHECK (attempt_number > 0),
  answers_enc    text NOT NULL,
  auto_score     numeric(5,2) CHECK (auto_score BETWEEN 0 AND 100),
  manual_score   numeric(5,2) CHECK (manual_score BETWEEN 0 AND 100),
  outcome        text CHECK (outcome IN ('pass','fail','pending')),
  started_at     timestamptz NOT NULL DEFAULT now(),
  submitted_at   timestamptz,
  graded_at      timestamptz,
  graded_by      uuid REFERENCES users(id),
  feedback_enc   text,
  voided_at      timestamptz,
  voided_by      uuid REFERENCES users(id),
  voided_reason  text,
  UNIQUE (exam_id, enrolment_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_off_edu_attempts_exam        ON off_edu_exam_attempts(exam_id);
CREATE INDEX IF NOT EXISTS idx_off_edu_attempts_enrolment   ON off_edu_exam_attempts(enrolment_id);

-- Seal answers after submission
CREATE OR REPLACE FUNCTION off_edu_seal_answers() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.submitted_at IS NOT NULL AND NEW.answers_enc <> OLD.answers_enc THEN
    RAISE EXCEPTION 'exam_attempt_sealed: answers cannot be changed after submission (id=%)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS off_edu_attempts_seal ON off_edu_exam_attempts;
CREATE TRIGGER off_edu_attempts_seal
  BEFORE UPDATE ON off_edu_exam_attempts
  FOR EACH ROW EXECUTE FUNCTION off_edu_seal_answers();

-- ------------------------------------------------------------------ practical evaluations

CREATE TABLE IF NOT EXISTS off_edu_practical_evaluations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrolment_id        uuid NOT NULL REFERENCES off_edu_enrolments(id),
  rubric_id           uuid,
  rubric_snapshot     jsonb NOT NULL DEFAULT '{}',
  scores              jsonb NOT NULL DEFAULT '{}',
  overall_score       numeric(5,2) CHECK (overall_score BETWEEN 0 AND 100),
  outcome             text CHECK (outcome IN ('competent','not_yet_competent','distinction')),
  evaluated_by        uuid NOT NULL REFERENCES users(id),
  evaluated_at        date NOT NULL,
  notes_enc           text,
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','acknowledged')),
  official_comment_enc text,
  acknowledged_at     timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_off_edu_evals_enrolment ON off_edu_practical_evaluations(enrolment_id);

-- ------------------------------------------------------------------ certificates

CREATE TABLE IF NOT EXISTS off_edu_certificates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrolment_id       uuid NOT NULL UNIQUE REFERENCES off_edu_enrolments(id),
  credential_id      uuid NOT NULL REFERENCES credentials(id),
  certificate_number text NOT NULL UNIQUE,
  issued_at          timestamptz NOT NULL DEFAULT now(),
  issued_by          uuid NOT NULL REFERENCES users(id),
  expires_at         timestamptz,
  revoked_at         timestamptz,
  revoked_by         uuid REFERENCES users(id),
  revoked_reason     text
);

CREATE INDEX IF NOT EXISTS idx_off_edu_certs_credential ON off_edu_certificates(credential_id);

-- ------------------------------------------------------------------ reminders (prerequisite-expiry, cert-expiry, etc.)

CREATE TABLE IF NOT EXISTS off_edu_reminders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  licence_id    uuid NOT NULL REFERENCES fed_licences(id),
  kind          text NOT NULL CHECK (kind IN ('prerequisite_expiring','certificate_expiring','enrolment_deadline','exam_due','cpd_shortfall')),
  reference_id  uuid,
  notify_at     timestamptz NOT NULL,
  notified_at   timestamptz,
  dismissed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_off_edu_reminders_uniq
  ON off_edu_reminders(licence_id, kind, reference_id)
  WHERE notified_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_off_edu_reminders_notify ON off_edu_reminders(notify_at) WHERE notified_at IS NULL;
